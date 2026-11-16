export interface VehicleCatalogEntry {
  id: number;
  make: string;
  model: string;
  serie?: string;
  body_style?: string;
  segment?: string;
  year_start?: number;
  year_end?: number;
  production_years?: string;
  cylinders?: number;
  displacement_cc?: number;
  power_hp?: number;
  power_rpm?: number;
  power_kw?: number;
  torque_nm?: number;
  torque_rpm?: number;
  fuel_type?: string;
  drivetrain?: string;
  gearbox?: string;
  top_speed_kmh?: number;
  accel_0_100_s?: number;
  weight_kg?: number;
  gross_weight_kg?: number;
  drag_cd?: number;
  tire_size?: string;
  spec_summary?: string;
}

const NUMERIC_FIELDS = new Set<keyof VehicleCatalogEntry>([
  'id',
  'year_start',
  'year_end',
  'cylinders',
  'displacement_cc',
  'power_hp',
  'power_rpm',
  'power_kw',
  'torque_nm',
  'torque_rpm',
  'top_speed_kmh',
  'accel_0_100_s',
  'weight_kg',
  'gross_weight_kg',
  'drag_cd',
]);

/**
 * Parses a vehicle catalog CSV string into a `Map` indexed by numeric vehicle `id`.
 * Handles quoted CSV fields and maps missing/empty values to `undefined` (never `NaN`).
 */
export function parseVehiclesCsv(csvContent: string): Map<number, VehicleCatalogEntry> {
  const catalog = new Map<number, VehicleCatalogEntry>();
  if (!csvContent.trim()) {
    return catalog;
  }

  const lines = csvContent.split(/\r?\n/);
  let headers: string[] | null = null;

  for (const rawLine of lines) {
    if (!rawLine.trim()) continue;

    const cells = splitCsvLine(rawLine);
    if (headers === null) {
      headers = cells.map((h) => h.trim());
      continue;
    }

    const row: Record<string, string | number | undefined> = {};
    for (let i = 0; i < headers.length; i++) {
      const key = headers[i];
      if (!key) continue;

      const rawVal = (cells[i] ?? '').trim();
      if (rawVal === '') {
        row[key] = undefined;
        continue;
      }

      if (NUMERIC_FIELDS.has(key as keyof VehicleCatalogEntry)) {
        const num = Number(rawVal);
        row[key] = Number.isFinite(num) ? num : undefined;
      } else {
        row[key] = rawVal;
      }
    }

    const id = row['id'];
    if (typeof id !== 'number' || !Number.isFinite(id)) {
      continue;
    }

    const entry: VehicleCatalogEntry = {
      id,
      make: typeof row['make'] === 'string' ? row['make'] : '',
      model: typeof row['model'] === 'string' ? row['model'] : '',
      serie: asOptionalString(row['serie']),
      body_style: asOptionalString(row['body_style']),
      segment: asOptionalString(row['segment']),
      year_start: asOptionalNumber(row['year_start']),
      year_end: asOptionalNumber(row['year_end']),
      production_years: asOptionalString(row['production_years']),
      cylinders: asOptionalNumber(row['cylinders']),
      displacement_cc: asOptionalNumber(row['displacement_cc']),
      power_hp: asOptionalNumber(row['power_hp']),
      power_rpm: asOptionalNumber(row['power_rpm']),
      power_kw: asOptionalNumber(row['power_kw']),
      torque_nm: asOptionalNumber(row['torque_nm']),
      torque_rpm: asOptionalNumber(row['torque_rpm']),
      fuel_type: asOptionalString(row['fuel_type']),
      drivetrain: asOptionalString(row['drivetrain']),
      gearbox: asOptionalString(row['gearbox']),
      top_speed_kmh: asOptionalNumber(row['top_speed_kmh']),
      accel_0_100_s: asOptionalNumber(row['accel_0_100_s']),
      weight_kg: asOptionalNumber(row['weight_kg']),
      gross_weight_kg: asOptionalNumber(row['gross_weight_kg']),
      drag_cd: asOptionalNumber(row['drag_cd']),
      tire_size: asOptionalString(row['tire_size']),
      spec_summary: asOptionalString(row['spec_summary']),
    };

    catalog.set(id, entry);
  }

  return catalog;
}

/**
 * Splits a single CSV line into cells, respecting double-quoted fields and escaped quotes (`""`).
 */
function splitCsvLine(line: string): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      cells.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  cells.push(current);
  return cells;
}

function asOptionalString(val: string | number | undefined): string | undefined {
  return typeof val === 'string' ? val : undefined;
}

function asOptionalNumber(val: string | number | undefined): number | undefined {
  return typeof val === 'number' && Number.isFinite(val) ? val : undefined;
}
