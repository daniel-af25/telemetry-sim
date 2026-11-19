import { splitCsvLine } from './csvUtils.ts';
import type { TelemetryPointRaw } from './types.ts';

const MILLI_G_THRESHOLD = 15;
const SPIKE_ACCEL_LIMIT_G = 25;
const SPIKE_GYRO_LIMIT_DPS = 2000;

const CORE_COLUMNS = new Set([
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

export interface ParseCsvResult {
  metadata: Record<string, string>;
  scalingFactor: number;
  extraChannels: string[];
  data: TelemetryPointRaw[];
}

interface RawParsedRow {
  timestamp: string | number;
  lat: number;
  lon: number;
  speed: number;
  accelX: number;
  accelY: number;
  accelZ: number;
  gyroZ: number;
  gyroX?: number;
  gyroY?: number;
  alt?: number;
  extras?: Record<string, number>;
}

/**
 * Parses a telemetry CSV string with optional `# key=value` metadata headers,
 * session-wide milli-G auto-scaling (`max(|accel|) > 15`), spike filtering,
 * and dynamic extra channel extraction into `extras`.
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
    return { metadata, scalingFactor: 1, extraChannels: [], data: [] };
  }

  const delimiter = headerLine.includes(';') && !headerLine.includes(',') ? ';' : ',';
  const headers = splitCsvLine(headerLine, delimiter).map((h) => h.trim());
  const colIndex = new Map<string, number>();
  const extraChannels: string[] = [];

  headers.forEach((header, idx) => {
    colIndex.set(header, idx);
    if (header && !CORE_COLUMNS.has(header)) {
      extraChannels.push(header);
    }
  });

  const rawRows: RawParsedRow[] = [];
  let maxAbsAccel = 0;

  for (const line of dataLines) {
    const cells = splitCsvLine(line, delimiter).map((c) => c.trim());
    if (cells.length < headers.length) continue;

    const rawTimestamp = getCell(cells, colIndex, 'timestamp');
    const numericTs = Number(rawTimestamp);
    const timestamp: string | number =
      rawTimestamp !== '' && Number.isFinite(numericTs) ? numericTs : rawTimestamp;

    const lat = Number(getCell(cells, colIndex, 'lat'));
    const lon = Number(getCell(cells, colIndex, 'lon'));
    const speed = Number(getCell(cells, colIndex, 'speed'));
    const accelX = Number(getCell(cells, colIndex, 'accelX'));
    const accelY = Number(getCell(cells, colIndex, 'accelY'));
    const accelZ = Number(getCell(cells, colIndex, 'accelZ'));
    const gyroZ = Number(getCell(cells, colIndex, 'gyroZ'));

    if (
      !Number.isFinite(lat) ||
      !Number.isFinite(lon) ||
      !Number.isFinite(speed) ||
      !Number.isFinite(accelX) ||
      !Number.isFinite(accelY) ||
      !Number.isFinite(accelZ) ||
      !Number.isFinite(gyroZ)
    ) {
      continue;
    }

    maxAbsAccel = Math.max(
      maxAbsAccel,
      Math.abs(accelX),
      Math.abs(accelY),
      Math.abs(accelZ),
    );

    const row: RawParsedRow = {
      timestamp,
      lat,
      lon,
      speed,
      accelX,
      accelY,
      accelZ,
      gyroZ,
    };

    const gyroX = parseOptionalNumber(cells, colIndex, 'gyroX');
    const gyroY = parseOptionalNumber(cells, colIndex, 'gyroY');
    const alt = parseOptionalNumber(cells, colIndex, 'alt');
    if (gyroX !== undefined) row.gyroX = gyroX;
    if (gyroY !== undefined) row.gyroY = gyroY;
    if (alt !== undefined) row.alt = alt;

    if (extraChannels.length > 0) {
      const extras: Record<string, number> = {};
      for (const channel of extraChannels) {
        const val = parseOptionalNumber(cells, colIndex, channel);
        if (val !== undefined) {
          extras[channel] = val;
        }
      }
      row.extras = extras;
    }

    rawRows.push(row);
  }

  const scalingFactor = maxAbsAccel > MILLI_G_THRESHOLD ? 1000 : 1;

  const data: TelemetryPointRaw[] = [];
  for (const row of rawRows) {
    const accelX = row.accelX / scalingFactor;
    const accelY = row.accelY / scalingFactor;
    const accelZ = row.accelZ / scalingFactor;

    // Spike filter: discard physically implausible sensor glitches
    if (
      Math.abs(accelX) > SPIKE_ACCEL_LIMIT_G ||
      Math.abs(accelY) > SPIKE_ACCEL_LIMIT_G ||
      Math.abs(accelZ) > SPIKE_ACCEL_LIMIT_G ||
      Math.abs(row.gyroZ) > SPIKE_GYRO_LIMIT_DPS
    ) {
      continue;
    }

    data.push({
      ...row,
      accelX,
      accelY,
      accelZ,
    });
  }

  return {
    metadata,
    scalingFactor,
    extraChannels,
    data,
  };
}

function getCell(
  cells: string[],
  colIndex: Map<string, number>,
  name: string,
): string {
  const idx = colIndex.get(name);
  return idx !== undefined ? (cells[idx] ?? '') : '';
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
