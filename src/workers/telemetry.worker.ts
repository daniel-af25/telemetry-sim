/**
 * Web Worker de processamento de telemetria (`telemetry.worker.ts`).
 * - `LOAD_CATALOG`: lazy-load de `/data/vehicles.index.json` (~286 KB gzip) com índice de busca.
 * - `SEARCH_VEHICLES`: pesquisa instantânea (< 5 ms em 25k registos) por tokens.
 * - `PROCESS_PRIMARY_CSV` / `PROCESS_GHOST_CSV`: executa `pipeline.ts` + `kinematics.ts` + `packToSoA()`
 *   e devolve `TelemetryTrackSoA` via `postMessage(msg, getTransferables(track))` (zero-copy).
 * - `CANCEL`: cancelamento cooperativo entre etapas com eventos `PROGRESS` e `ERROR` limpos.
 *
 * Verificação de tipos & build:
 *   npm run typecheck && npm run build
 */
import { computeKammIndex } from '../core/kamm.ts';
import { reconstructKinematics } from '../core/kinematics.ts';
import { runTelemetryPipeline } from '../core/pipeline.ts';
import { evaluateIncidentSlip } from '../core/scoring.ts';
import {
  getTransferables,
  packToSoA,
  type ProcessedFrameInput,
} from '../core/soa.ts';
import type { VehicleCatalogEntry } from '../core/vehicleCatalog.ts';
import type {
  ProcessedTrackPayload,
  TrackRole,
  VehicleIndexFile,
  VehicleSummary,
  WorkerPipelineOptions,
  WorkerProgressStage,
  WorkerRequest,
  WorkerResponse,
} from './protocol.ts';

const GRAVITY_MS2 = 9.80665;
const DEFAULT_CATALOG_URL = '/data/vehicles.index.json';
const DEFAULT_SEARCH_LIMIT = 30;

export interface IndexedCatalog {
  byId: Map<number, VehicleSummary>;
  items: VehicleSummary[];
  searchKeys: string[];
  makesCount: number;
}

/**
 * Expands the compact tabular `VehicleIndexFile` into an in-memory lookup map
 * and pre-lowercased search keys for < 5 ms token search across 25k+ vehicles.
 */
export function buildCatalogIndex(file: VehicleIndexFile): IndexedCatalog {
  const byId = new Map<number, VehicleSummary>();
  const items: VehicleSummary[] = new Array(file.rows.length);
  const searchKeys: string[] = new Array(file.rows.length);

  for (let i = 0; i < file.rows.length; i++) {
    const row = file.rows[i];
    if (!row) continue;

    const [
      id,
      makeIdx,
      model,
      years,
      cylIdx,
      powerHp,
      curbMassKg,
      drivetrainIdx,
      tireSize,
      dragCd,
      segmentIdx,
    ] = row;

    const make = makeIdx >= 0 ? (file.makes[makeIdx] ?? '') : '';
    const cylinders = cylIdx >= 0 ? file.cylinders[cylIdx] : undefined;
    const drivetrain = drivetrainIdx >= 0 ? file.drivetrains[drivetrainIdx] : undefined;
    const segment = segmentIdx >= 0 ? file.segments[segmentIdx] : undefined;

    const summary: VehicleSummary = {
      id,
      make,
      model,
      years,
      ...(cylinders !== undefined ? { cylinders } : {}),
      ...(powerHp !== null ? { powerHp } : {}),
      ...(curbMassKg !== null ? { curbMassKg } : {}),
      ...(drivetrain !== undefined ? { drivetrain } : {}),
      ...(tireSize !== '' ? { tireSize } : {}),
      ...(dragCd !== null ? { dragCd } : {}),
      ...(segment !== undefined ? { segment } : {}),
    };

    byId.set(id, summary);
    items[i] = summary;
    searchKeys[i] = `${make} ${model} ${years} ${cylinders ?? ''} ${powerHp ?? ''}`.toLowerCase();
  }

  return {
    byId,
    items,
    searchKeys,
    makesCount: file.makes.length,
  };
}

/**
 * Fast token-based substring search over `IndexedCatalog` (< 5 ms for 25k entries).
 */
export function searchCatalogIndex(
  index: IndexedCatalog,
  query: string,
  limit: number = DEFAULT_SEARCH_LIMIT,
): VehicleSummary[] {
  const tokens = query
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((t) => t.length > 0);

  if (tokens.length === 0) {
    return index.items.slice(0, limit);
  }

  const results: VehicleSummary[] = [];
  const maxResults = Math.max(1, limit);

  for (let i = 0; i < index.searchKeys.length; i++) {
    const key = index.searchKeys[i];
    if (!key) continue;

    let matched = true;
    for (let t = 0; t < tokens.length; t++) {
      const tok = tokens[t];
      if (tok !== undefined && !key.includes(tok)) {
        matched = false;
        break;
      }
    }

    if (matched) {
      const item = index.items[i];
      if (item) {
        results.push(item);
        if (results.length >= maxResults) break;
      }
    }
  }

  return results;
}

function summaryToCatalogEntry(summary?: VehicleSummary): Partial<VehicleCatalogEntry> | undefined {
  if (!summary) return undefined;
  return {
    id: summary.id,
    make: summary.make,
    model: summary.model,
    cylinders: summary.cylinders,
    power_hp: summary.powerHp,
    weight_kg: summary.curbMassKg,
    drivetrain: summary.drivetrain,
    tire_size: summary.tireSize,
    drag_cd: summary.dragCd,
    segment: summary.segment,
  };
}

/**
 * Runs the full headless pipeline (`pipeline.ts` + `kinematics.ts` + `packToSoA`),
 * reporting progress stages and checking cancellation cooperatively.
 */
export function processCsvToTrack(
  csvText: string,
  options: WorkerPipelineOptions | undefined,
  catalogEntry: Partial<VehicleCatalogEntry> | undefined,
  onProgress?: (stage: WorkerProgressStage, progress: number, message?: string) => void,
  isCancelled?: () => boolean,
): ProcessedTrackPayload | null {
  onProgress?.('parsing', 0.1, 'Parsing telemetry CSV');
  if (isCancelled?.()) return null;

  onProgress?.('calibrating', 0.3, 'Calibrating IMU & resolving vehicle specs');
  const pipeline = runTelemetryPipeline(csvText, {
    ...options,
    catalogEntry: catalogEntry ?? null,
  });
  if (isCancelled?.()) return null;

  onProgress?.('kinematics', 0.65, 'Reconstructing ENU trajectory & tunnels');
  const kinematics = reconstructKinematics(pipeline.samplesIso);
  if (isCancelled?.()) return null;

  onProgress?.('scoring', 0.85, 'Packing zero-copy SoA telemetry buffers');
  const n = Math.min(
    pipeline.samplesIso.length,
    pipeline.loadTransfers.length,
    kinematics.points.length,
  );
  const frames: ProcessedFrameInput[] = new Array(n);

  for (let i = 0; i < n; i++) {
    const s = pipeline.samplesIso[i];
    const lt = pipeline.loadTransfers[i];
    const kp = kinematics.points[i];
    if (!s || !lt || !kp) continue;

    const axG = s.ax / GRAVITY_MS2;
    const ayG = s.ay / GRAVITY_MS2;
    const kammIndex = computeKammIndex(axG, ayG, pipeline.kammLimits);
    const slip = evaluateIncidentSlip(s.ay, s.speedMs, s.omegaZ);

    frames[i] = {
      t: s.elapsedSec,
      lat: kp.lat,
      lon: kp.lon,
      x: kp.x,
      y: kp.y,
      speedMs: s.speedMs,
      ax: s.ax,
      ay: s.ay,
      az: s.az,
      omegaZ: s.omegaZ,
      yaw: kp.yawRad,
      steerRad: lt.steerRad,
      rollRad: lt.rollRad,
      pitchRad: lt.pitchRad,
      fzFL: lt.fzFL,
      fzFR: lt.fzFR,
      fzRL: lt.fzRL,
      fzRR: lt.fzRR,
      kammIndex,
      roadGradePct: s.roadGradePct,
      distM: kp.distM,
      gpsValid: kp.gpsValid,
      isGap: s.isGap,
      isTunnelDr: kp.isTunnelDr,
      isSlip: slip.isSlip,
    };
  }

  const track = packToSoA(frames);
  if (isCancelled?.()) return null;

  onProgress?.('ready', 1.0, 'Telemetry ready');

  return {
    track,
    origin: kinematics.origin,
    profile: pipeline.profile,
    metadata: pipeline.metadata,
    ...(pipeline.sessionVehicleMeta ? { sessionVehicleMeta: pipeline.sessionVehicleMeta } : {}),
    scalingFactor: pipeline.scalingFactor,
    extraChannels: pipeline.extraChannels,
    ...(pipeline.extraChannelSeries ? { extraChannelSeries: pipeline.extraChannelSeries } : {}),
    vehicleSpecs: pipeline.vehicleSpecs,
    kammLimits: pipeline.kammLimits,
    calibrationStats: pipeline.calibrationStats,
    incidents: pipeline.incidents,
    pillars: pipeline.pillars,
    summary: pipeline.summary,
  };
}

// ---------------------------------------------------------------------------
// Dedicated Web Worker Runtime Loop
// ---------------------------------------------------------------------------

interface WorkerScopeLike {
  postMessage(message: WorkerResponse, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (ev: MessageEvent<WorkerRequest>) => void): void;
}

let cachedCatalog: IndexedCatalog | null = null;
const cancelledRequestIds = new Set<string>();

function getWorkerScope(): WorkerScopeLike | null {
  if (typeof self !== 'undefined' && typeof (self as unknown as WorkerScopeLike).postMessage === 'function') {
    return self as unknown as WorkerScopeLike;
  }
  return null;
}

const workerScope = getWorkerScope();

function send(msg: WorkerResponse, transfer?: Transferable[]): void {
  if (!workerScope) return;
  if (transfer && transfer.length > 0) {
    workerScope.postMessage(msg, transfer);
  } else {
    workerScope.postMessage(msg);
  }
}

async function handleLoadCatalog(requestId: string, url: string): Promise<void> {
  if (cachedCatalog) {
    send({
      type: 'CATALOG_LOADED',
      requestId,
      count: cachedCatalog.items.length,
      makesCount: cachedCatalog.makesCount,
    });
    return;
  }

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch vehicle catalog (${response.status} ${response.statusText})`);
  }
  const indexFile = (await response.json()) as VehicleIndexFile;
  cachedCatalog = buildCatalogIndex(indexFile);

  send({
    type: 'CATALOG_LOADED',
    requestId,
    count: cachedCatalog.items.length,
    makesCount: cachedCatalog.makesCount,
  });
}

function handleSearchVehicles(requestId: string, query: string, limit?: number): void {
  if (!cachedCatalog) {
    send({
      type: 'ERROR',
      requestId,
      code: 'CATALOG_NOT_LOADED',
      message: 'Vehicle catalog must be loaded with LOAD_CATALOG before searching.',
    });
    return;
  }

  const t0 = performance.now();
  const results = searchCatalogIndex(cachedCatalog, query, limit);
  const elapsedMs = performance.now() - t0;

  send({
    type: 'SEARCH_RESULTS',
    requestId,
    query,
    results,
    elapsedMs,
  });
}

function handleProcessCsv(
  requestId: string,
  role: TrackRole,
  csvText: string,
  vehicleId?: number,
  options?: WorkerPipelineOptions,
): void {
  const catalogSummary =
    vehicleId !== undefined && cachedCatalog ? cachedCatalog.byId.get(vehicleId) : undefined;
  const catalogEntry = summaryToCatalogEntry(catalogSummary);

  const payload = processCsvToTrack(
    csvText,
    options,
    catalogEntry,
    (stage, progress, message) => {
      send({ type: 'PROGRESS', requestId, stage, progress, ...(message ? { message } : {}) });
    },
    () => cancelledRequestIds.has(requestId),
  );

  if (payload === null || cancelledRequestIds.has(requestId)) {
    cancelledRequestIds.delete(requestId);
    send({ type: 'CANCELLED', requestId, targetRequestId: requestId });
    return;
  }

  const transferables = getTransferables(payload.track);
  if (payload.extraChannelSeries) {
    for (const arr of Object.values(payload.extraChannelSeries)) {
      transferables.push(arr.buffer as ArrayBuffer);
    }
  }
  send(
    {
      type: 'PROCESSED_TRACK',
      requestId,
      role,
      payload,
    },
    transferables,
  );
}

if (workerScope) {
  workerScope.addEventListener('message', (event: MessageEvent<WorkerRequest>) => {
    const req = event.data;
    if (!req || typeof req !== 'object') return;

    const run = async () => {
      try {
        switch (req.type) {
          case 'LOAD_CATALOG':
            await handleLoadCatalog(req.requestId, req.url ?? DEFAULT_CATALOG_URL);
            break;
          case 'SEARCH_VEHICLES':
            handleSearchVehicles(req.requestId, req.query, req.limit);
            break;
          case 'PROCESS_PRIMARY_CSV':
            handleProcessCsv(req.requestId, 'primary', req.csvText, req.vehicleId, req.options);
            break;
          case 'PROCESS_GHOST_CSV':
            handleProcessCsv(req.requestId, 'ghost', req.csvText, req.vehicleId, req.options);
            break;
          case 'CANCEL':
            if (req.targetRequestId) {
              cancelledRequestIds.add(req.targetRequestId);
            }
            send({
              type: 'CANCELLED',
              requestId: req.requestId,
              ...(req.targetRequestId ? { targetRequestId: req.targetRequestId } : {}),
            });
            break;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        send({
          type: 'ERROR',
          requestId: req.requestId,
          code: 'WORKER_EXECUTION_ERROR',
          message,
        });
      }
    };

    void run();
  });
}
