/**
 * Protocolo tipado de mensagens entre a main thread e `src/workers/telemetry.worker.ts`.
 * Suporta carregamento lazy do catálogo de veículos, pesquisa < 5 ms em 25k registos,
 * processamento zero-copy (`TelemetryTrackSoA`) para viagem primária e Ghost Car (Fase 6),
 * progresso por etapa e cancelamento limpo.
 *
 * Verificação de tipos:
 *   npm run typecheck
 */
import type { CalibrationStats } from '../core/calibration.ts';
import type { DynamicKammLimitsResult } from '../core/kamm.ts';
import type { Wgs84Coord } from '../core/kinematics.ts';
import type { CsvProfile, ParsedSessionVehicleMeta } from '../core/parser.ts';
import type { PipelineOptions, TelemetryPipelineSummary } from '../core/pipeline.ts';
import type { DrivingSkillPillar, Incident } from '../core/scoring.ts';
import type { TelemetryTrackSoA } from '../core/soa.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';

export type WorkerProgressStage =
  | 'parsing'
  | 'calibrating'
  | 'kinematics'
  | 'scoring'
  | 'ready';

export type TrackRole = 'primary' | 'ghost';

/** Compact index schema produced by `scripts/buildVehicleIndex.ts`. */
export type VehicleIndexRow = [
  id: number,
  makeIdx: number,
  model: string,
  years: string,
  cylIdx: number,
  powerHp: number | null,
  curbMassKg: number | null,
  drivetrainIdx: number,
  tireSize: string,
  dragCd: number | null,
  segmentIdx: number,
];

export interface VehicleIndexFile {
  version: number;
  count: number;
  makes: string[];
  cylinders: string[];
  drivetrains: string[];
  segments: string[];
  fields: readonly string[];
  rows: VehicleIndexRow[];
}

export interface VehicleSummary {
  id: number;
  make: string;
  model: string;
  years: string;
  cylinders?: string;
  powerHp?: number;
  curbMassKg?: number;
  drivetrain?: string;
  tireSize?: string;
  dragCd?: number;
  segment?: string;
}

export type WorkerPipelineOptions = Omit<PipelineOptions, 'catalogEntry'>;

// ---------------------------------------------------------------------------
// Requests (Main Thread -> Worker)
// ---------------------------------------------------------------------------

export interface LoadCatalogRequest {
  type: 'LOAD_CATALOG';
  requestId: string;
  url?: string;
}

export interface SearchVehiclesRequest {
  type: 'SEARCH_VEHICLES';
  requestId: string;
  query: string;
  limit?: number;
}

export interface ProcessPrimaryCsvRequest {
  type: 'PROCESS_PRIMARY_CSV';
  requestId: string;
  csvText: string;
  vehicleId?: number;
  options?: WorkerPipelineOptions;
}

export interface ProcessGhostCsvRequest {
  type: 'PROCESS_GHOST_CSV';
  requestId: string;
  csvText: string;
  vehicleId?: number;
  options?: WorkerPipelineOptions;
}

export interface CancelRequest {
  type: 'CANCEL';
  requestId: string;
  targetRequestId?: string;
}

export type WorkerRequest =
  | LoadCatalogRequest
  | SearchVehiclesRequest
  | ProcessPrimaryCsvRequest
  | ProcessGhostCsvRequest
  | CancelRequest;

// ---------------------------------------------------------------------------
// Responses (Worker -> Main Thread)
// ---------------------------------------------------------------------------

export interface CatalogLoadedResponse {
  type: 'CATALOG_LOADED';
  requestId: string;
  count: number;
  makesCount: number;
}

export interface SearchResultsResponse {
  type: 'SEARCH_RESULTS';
  requestId: string;
  query: string;
  results: VehicleSummary[];
  elapsedMs: number;
}

export interface ProgressResponse {
  type: 'PROGRESS';
  requestId: string;
  stage: WorkerProgressStage;
  progress: number;
  message?: string;
}

export interface ProcessedTrackPayload {
  track: TelemetryTrackSoA;
  origin: Wgs84Coord;
  profile: CsvProfile;
  metadata: Record<string, string>;
  sessionVehicleMeta?: ParsedSessionVehicleMeta;
  scalingFactor: number;
  extraChannels: string[];
  vehicleSpecs: ResolvedVehicleSpecs;
  kammLimits: DynamicKammLimitsResult;
  calibrationStats: CalibrationStats;
  incidents: Incident[];
  pillars: DrivingSkillPillar[];
  summary: TelemetryPipelineSummary;
}

export interface ProcessedTrackResponse {
  type: 'PROCESSED_TRACK';
  requestId: string;
  role: TrackRole;
  payload: ProcessedTrackPayload;
}

export interface CancelledResponse {
  type: 'CANCELLED';
  requestId: string;
  targetRequestId?: string;
}

export interface ErrorResponse {
  type: 'ERROR';
  requestId: string;
  code: string;
  message: string;
}

export type WorkerResponse =
  | CatalogLoadedResponse
  | SearchResultsResponse
  | ProgressResponse
  | ProcessedTrackResponse
  | CancelledResponse
  | ErrorResponse;
