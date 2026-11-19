/**
 * Compila o catálogo bruto `data/vehicles.csv` (~25k veículos) num índice JSON compacto
 * (`public/data/vehicles.index.json`, ~286 KB gzip) pronto para lazy-load no Web Worker.
 * Usa apenas massa em ordem de marcha (`weight_kg`), nunca `gross_weight_kg` (GVWR).
 *
 * Como executar:
 *   npm run build:catalog
 *   node scripts/buildVehicleIndex.ts
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parseVehiclesCsv } from '../src/core/vehicleCatalog.ts';

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

const INPUT_PATH = resolve(process.cwd(), 'data/vehicles.csv');
const OUTPUT_PATH = resolve(process.cwd(), 'public/data/vehicles.index.json');

const FIELDS = [
  'id',
  'makeIdx',
  'model',
  'years',
  'cylIdx',
  'powerHp',
  'curbMassKg',
  'drivetrainIdx',
  'tireSize',
  'dragCd',
  'segmentIdx',
] as const;

function createStringTable(): { values: string[]; intern: (value?: string) => number } {
  const map = new Map<string, number>();
  const values: string[] = [];

  return {
    values,
    intern(value?: string): number {
      if (!value) return -1;
      const existing = map.get(value);
      if (existing !== undefined) return existing;
      const idx = values.length;
      values.push(value);
      map.set(value, idx);
      return idx;
    },
  };
}

const csvContent = readFileSync(INPUT_PATH, 'utf-8');
const catalog = parseVehiclesCsv(csvContent);

const makes = createStringTable();
const cylinders = createStringTable();
const drivetrains = createStringTable();
const segments = createStringTable();

const rows: VehicleIndexRow[] = [];

for (const entry of catalog.values()) {
  const years =
    entry.year_start !== undefined || entry.year_end !== undefined
      ? `${entry.year_start ?? ''}-${entry.year_end ?? ''}`
      : '';

  rows.push([
    entry.id,
    makes.intern(entry.make),
    entry.model,
    years,
    cylinders.intern(entry.cylinders),
    entry.power_hp ?? null,
    // Curb mass only (never gross_weight_kg / GVWR per AGENTS.md)
    entry.weight_kg ?? null,
    drivetrains.intern(entry.drivetrain),
    entry.tire_size ?? '',
    entry.drag_cd ?? null,
    segments.intern(entry.segment),
  ]);
}

const indexData: VehicleIndexFile = {
  version: 1,
  count: rows.length,
  makes: makes.values,
  cylinders: cylinders.values,
  drivetrains: drivetrains.values,
  segments: segments.values,
  fields: FIELDS,
  rows,
};

const json = JSON.stringify(indexData);
mkdirSync(dirname(OUTPUT_PATH), { recursive: true });
writeFileSync(OUTPUT_PATH, json, 'utf-8');

const rawBytes = Buffer.byteLength(json, 'utf-8');
const gzipBytes = gzipSync(json).byteLength;

console.log(
  `Built ${OUTPUT_PATH}: ${rows.length} vehicles (${makes.values.length} makes, ` +
    `${cylinders.values.length} cylinder configs) | ` +
    `${(rawBytes / (1024 * 1024)).toFixed(2)} MB raw | ${(gzipBytes / 1024).toFixed(1)} KB gzip`,
);
