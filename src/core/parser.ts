import { splitCsvLine } from './csvUtils.ts';
import { computeSampleTiming, parseTimestampMs } from './timestamps.ts';
import type { TelemetryPointRaw } from './types.ts';

const MILLI_G_MEDIAN_ACCEL_Z_THRESHOLD = 100;
const MILLI_G_P95_XY_THRESHOLD = 15;
const SPIKE_ACCEL_LIMIT_G = 25;
const SPIKE_GYRO_LIMIT_DPS = 2000;

export type CsvProfile = 'labsis_v22_export' | 'generic_iso';

export interface ParsedSessionVehicleMeta {
  sessionId?: string;
  driver?: string;
  vehicle?: string;
  powerHp?: number;
  curbWeightKg?: number;
  pilotWeightKg?: number;
  passengerWeightKg?: number;
  payloadKg?: number;
  grossMassKg?: number;
  limitLatG?: number;
  limitAccelG?: number;
  limitBrakeG?: number;
}

export interface ParseCsvResult {
  profile: CsvProfile;
  metadata: Record<string, string>;
  sessionVehicleMeta?: ParsedSessionVehicleMeta;
  scalingFactor: number;
  extraChannels: string[];
  data: TelemetryPointRaw[];
}

const GENERIC_CORE_COLUMNS = new Set([
  'timestamp',
  'lat',
  'lon',
  'speed',
  'accelX',
  'accelY',
  'accelZ',
  'gyroZ',
  'gyroX',
  'gyroY',
  'alt',
]);

const V22_KNOWN_COLUMNS = new Set([
  'sample_index',
  'timestamp',
  'timestamp_ms',
  'elapsed_s',
  'dt_s',
  'lat',
  'lon',
  'speed_kmh',
  'speed_ms',
  'distance_cum_km',
  'heading_deg',
  'accel_x_raw_g',
  'accel_y_raw_g',
  'accel_z_raw_g',
  'accel_lat_comp_g',
  'accel_lon_comp_g',
  'gyro_x_dps',
  'gyro_y_dps',
  'gyro_z_dps',
  'road_grade_pct',
  'kamm_index',
  'session_id',
  'driver',
  'vehicle',
  'power_hp',
  'curb_weight_kg',
  'pilot_weight_kg',
  'passenger_weight_kg',
  'payload_kg',
  'gross_mass_kg',
  'limit_lat_g',
  'limit_accel_g',
  'limit_brake_g',
]);

interface RawParsedRow {
  timestamp: string | number;
  timestampMs: number;
  lat: number | null;
  lon: number | null;
  gpsValid: boolean;
  speed: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  accelLatCompG?: number;
  accelLonCompG?: number;
  gyroZ: number;
  gyroX?: number;
  gyroY?: number;
  alt?: number;
  roadGradePct?: number;
  kammIndex?: number;
  extras?: Record<string, number>;
}

/**
 * Multi-format telemetry CSV parser supporting:
 * - `labsis_v22_export` (33-column session exports with compensated G, road grade, and vehicle metadata)
 * - `generic_iso` (ISO 8855 / synthetic fixtures with `# key=value` headers and robust milli-G detection)
 */
export function parseCsv(csvContent: string): ParseCsvResult {
  const metadata: Record<string, string> = {};
  const lines = csvContent.split(/\r?\n/);

  let headerLine: string | null = null;
  const dataLines: string[] = [];

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith('#')) {
      const commentBody = trimmed.slice(1).trim();
      const eqIdx = commentBody.indexOf('=');
      if (eqIdx !== -1) {
        const key = commentBody.slice(0, eqIdx).trim();
        const value = commentBody.slice(eqIdx + 1).trim();
        if (key) {
          metadata[key] = value;
        }
      }
      continue;
    }

    if (headerLine === null) {
      headerLine = trimmed;
    } else {
      dataLines.push(trimmed);
    }
  }

  if (!headerLine) {
    return {
      profile: 'generic_iso',
      metadata,
      scalingFactor: 1,
      extraChannels: [],
      data: [],
    };
  }

  const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
  const headers = splitCsvLine(headerLine, delimiter).map((h) => h.trim());
  const colIndex = new Map<string, number>();

  headers.forEach((header, idx) => {
    colIndex.set(header, idx);
  });

  const isV22 =
    metadata['frame'] !== 'iso8855' &&
    (colIndex.has('accel_x_raw_g') ||
      colIndex.has('speed_kmh') ||
      (colIndex.has('accel_lat_comp_g') && colIndex.has('accel_lon_comp_g')));

  const profile: CsvProfile = isV22 ? 'labsis_v22_export' : 'generic_iso';
  const knownCols = isV22 ? V22_KNOWN_COLUMNS : GENERIC_CORE_COLUMNS;

  const candidateExtraChannels = headers.filter((h) => h !== '' && !knownCols.has(h));
  const numericExtraSet = new Set<string>();

  const rawRows: RawParsedRow[] = [];
  const absAccelZValues: number[] = [];
  const maxAbsXyValues: number[] = [];
  let sessionVehicleMeta: ParsedSessionVehicleMeta | undefined;

  for (const line of dataLines) {
    const cells = splitCsvLine(line, delimiter).map((c) => c.trim());
    if (cells.length < headers.length) continue;

    const rawTimestamp = getCell(cells, colIndex, 'timestamp');
    const numericTs = Number(rawTimestamp);
    const timestamp: string | number =
      rawTimestamp !== '' && Number.isFinite(numericTs) ? numericTs : rawTimestamp;

    const rawTsMs = isV22 ? getCell(cells, colIndex, 'timestamp_ms') : '';
    const timestampMs =
      rawTsMs !== '' ? parseTimestampMs(rawTsMs) : parseTimestampMs(timestamp);

    const rawLat = parseOptionalNumber(cells, colIndex, 'lat');
    const rawLon = parseOptionalNumber(cells, colIndex, 'lon');
    const isTunnel =
      rawLat === undefined ||
      rawLon === undefined ||
      (rawLat === 0 && rawLon === 0);
    const lat = isTunnel ? null : rawLat;
    const lon = isTunnel ? null : rawLon;
    const gpsValid = !isTunnel;

    const speed = Number(
      isV22 ? getCell(cells, colIndex, 'speed_kmh') : getCell(cells, colIndex, 'speed'),
    );
    const accelX = Number(
      isV22 ? getCell(cells, colIndex, 'accel_x_raw_g') : getCell(cells, colIndex, 'accelX'),
    );
    const accelY = Number(
      isV22 ? getCell(cells, colIndex, 'accel_y_raw_g') : getCell(cells, colIndex, 'accelY'),
    );
    const accelZ = Number(
      isV22 ? getCell(cells, colIndex, 'accel_z_raw_g') : getCell(cells, colIndex, 'accelZ'),
    );
    const gyroZ = Number(
      isV22 ? getCell(cells, colIndex, 'gyro_z_dps') : getCell(cells, colIndex, 'gyroZ'),
    );

    if (
      !Number.isFinite(speed) ||
      !Number.isFinite(accelX) ||
      !Number.isFinite(accelY) ||
      !Number.isFinite(accelZ) ||
      !Number.isFinite(gyroZ)
    ) {
      continue;
    }

    absAccelZValues.push(Math.abs(accelZ));
    maxAbsXyValues.push(Math.max(Math.abs(accelX), Math.abs(accelY)));

    const row: RawParsedRow = {
      timestamp,
      timestampMs,
      lat,
      lon,
      gpsValid,
      speed,
      accelX,
      accelY,
      accelZ,
      gyroZ,
    };

    const gyroX = parseOptionalNumber(
      cells,
      colIndex,
      isV22 ? 'gyro_x_dps' : 'gyroX',
    );
    const gyroY = parseOptionalNumber(
      cells,
      colIndex,
      isV22 ? 'gyro_y_dps' : 'gyroY',
    );
    const alt = parseOptionalNumber(cells, colIndex, 'alt');
    if (gyroX !== undefined) row.gyroX = gyroX;
    if (gyroY !== undefined) row.gyroY = gyroY;
    if (alt !== undefined) row.alt = alt;

    if (isV22) {
      const accelLatCompG = parseOptionalNumber(cells, colIndex, 'accel_lat_comp_g');
      const accelLonCompG = parseOptionalNumber(cells, colIndex, 'accel_lon_comp_g');
      const roadGradePct = parseOptionalNumber(cells, colIndex, 'road_grade_pct');
      const kammIndex = parseOptionalNumber(cells, colIndex, 'kamm_index');
      if (accelLatCompG !== undefined) row.accelLatCompG = accelLatCompG;
      if (accelLonCompG !== undefined) row.accelLonCompG = accelLonCompG;
      if (roadGradePct !== undefined) row.roadGradePct = roadGradePct;
      if (kammIndex !== undefined) row.kammIndex = kammIndex;

      if (!sessionVehicleMeta) {
        sessionVehicleMeta = extractV22SessionMeta(cells, colIndex);
      }
    }

    if (candidateExtraChannels.length > 0) {
      const extras: Record<string, number> = {};
      for (const channel of candidateExtraChannels) {
        const val = parseOptionalNumber(cells, colIndex, channel);
        if (val !== undefined) {
          extras[channel] = val;
          numericExtraSet.add(channel);
        }
      }
      if (Object.keys(extras).length > 0) {
        row.extras = extras;
      }
    }

    rawRows.push(row);
  }

  const medianAbsAccelZ = computeMedian(absAccelZValues);
  const p95MaxAbsXy = computePercentile(maxAbsXyValues, 0.95);
  const scalingFactor =
    !isV22 &&
    (medianAbsAccelZ > MILLI_G_MEDIAN_ACCEL_Z_THRESHOLD ||
      p95MaxAbsXy > MILLI_G_P95_XY_THRESHOLD)
      ? 1000
      : 1;

  const filteredRows: RawParsedRow[] = [];
  for (const row of rawRows) {
    const accelX = row.accelX / scalingFactor;
    const accelY = row.accelY / scalingFactor;
    const accelZ = row.accelZ / scalingFactor;

    if (
      Math.abs(accelX) > SPIKE_ACCEL_LIMIT_G ||
      Math.abs(accelY) > SPIKE_ACCEL_LIMIT_G ||
      Math.abs(accelZ) > SPIKE_ACCEL_LIMIT_G ||
      Math.abs(row.gyroZ) > SPIKE_GYRO_LIMIT_DPS
    ) {
      continue;
    }

    filteredRows.push({
      ...row,
      accelX,
      accelY,
      accelZ,
    });
  }

  const timing = computeSampleTiming(filteredRows.map((r) => r.timestampMs));
  const data: TelemetryPointRaw[] = filteredRows.map((row, idx) => {
    const sampleTiming = timing[idx];
    return {
      ...row,
      elapsedSec: sampleTiming?.elapsedSec ?? 0,
      dtSec: sampleTiming?.dtSec ?? 0.2,
      isGap: sampleTiming?.isGap ?? false,
    };
  });

  const extraChannels = candidateExtraChannels.filter((ch) => numericExtraSet.has(ch));

  return {
    profile,
    metadata,
    ...(sessionVehicleMeta ? { sessionVehicleMeta } : {}),
    scalingFactor,
    extraChannels,
    data,
  };
}

function extractV22SessionMeta(
  cells: string[],
  colIndex: Map<string, number>,
): ParsedSessionVehicleMeta {
  const sessionId = parseOptionalString(cells, colIndex, 'session_id');
  const driver = parseOptionalString(cells, colIndex, 'driver');
  const vehicle = parseOptionalString(cells, colIndex, 'vehicle');
  const powerHp = parseOptionalNumber(cells, colIndex, 'power_hp');
  const curbWeightKg = parseOptionalNumber(cells, colIndex, 'curb_weight_kg');
  const pilotWeightKg = parseOptionalNumber(cells, colIndex, 'pilot_weight_kg');
  const passengerWeightKg = parseOptionalNumber(cells, colIndex, 'passenger_weight_kg');
  const payloadKg = parseOptionalNumber(cells, colIndex, 'payload_kg');
  const grossMassKg = parseOptionalNumber(cells, colIndex, 'gross_mass_kg');
  const limitLatG = parseOptionalNumber(cells, colIndex, 'limit_lat_g');
  const limitAccelG = parseOptionalNumber(cells, colIndex, 'limit_accel_g');
  const limitBrakeG = parseOptionalNumber(cells, colIndex, 'limit_brake_g');

  return {
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(driver !== undefined ? { driver } : {}),
    ...(vehicle !== undefined ? { vehicle } : {}),
    ...(powerHp !== undefined ? { powerHp } : {}),
    ...(curbWeightKg !== undefined ? { curbWeightKg } : {}),
    ...(pilotWeightKg !== undefined ? { pilotWeightKg } : {}),
    ...(passengerWeightKg !== undefined ? { passengerWeightKg } : {}),
    ...(payloadKg !== undefined ? { payloadKg } : {}),
    ...(grossMassKg !== undefined ? { grossMassKg } : {}),
    ...(limitLatG !== undefined ? { limitLatG } : {}),
    ...(limitAccelG !== undefined ? { limitAccelG } : {}),
    ...(limitBrakeG !== undefined ? { limitBrakeG } : {}),
  };
}

function computeMedian(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  const a = sorted[mid - 1] ?? 0;
  const b = sorted[mid] ?? 0;
  return (a + b) / 2;
}

function computePercentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
  return sorted[idx] ?? 0;
}

function getCell(
  cells: string[],
  colIndex: Map<string, number>,
  name: string,
): string {
  const idx = colIndex.get(name);
  return idx !== undefined ? (cells[idx] ?? '') : '';
}

function parseOptionalString(
  cells: string[],
  colIndex: Map<string, number>,
  name: string,
): string | undefined {
  const raw = getCell(cells, colIndex, name);
  return raw !== '' ? raw : undefined;
}

function parseOptionalNumber(
  cells: string[],
  colIndex: Map<string, number>,
  name: string,
): number | undefined {
  const raw = getCell(cells, colIndex, name);
  if (raw === '') return undefined;
  const num = Number(raw);
  return Number.isFinite(num) ? num : undefined;
}
