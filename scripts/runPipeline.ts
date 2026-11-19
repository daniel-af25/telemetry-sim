import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import type { CalibrationMode } from '../src/core/calibration.ts';
import { runTelemetryPipeline } from '../src/core/pipeline.ts';
import type { TripMode } from '../src/core/types.ts';

const DEFAULT_CSV_DIR = resolve(process.cwd(), 'tmp/csv');

const VALID_CALIBRATION_MODES = new Set<CalibrationMode>([
  'auto',
  'use_csv_compensated',
  'recalibrate_raw',
]);
const VALID_TRIP_MODES = new Set<TripMode>(['road', 'competition']);

function resolveCsvTargets(arg?: string): string[] {
  if (!arg) {
    if (!existsSync(DEFAULT_CSV_DIR)) {
      console.error(`Pasta não encontrada: ${DEFAULT_CSV_DIR}`);
      console.error('Cria tmp/csv e coloca lá os CSVs, ou passa o caminho: node scripts/runPipeline.ts <ficheiro.csv>');
      process.exit(1);
    }

    const files = readdirSync(DEFAULT_CSV_DIR)
      .filter((f) => f.toLowerCase().endsWith('.csv'))
      .sort()
      .map((f) => join(DEFAULT_CSV_DIR, f));

    if (files.length === 0) {
      console.error(`Nenhum ficheiro .csv encontrado em ${DEFAULT_CSV_DIR}`);
      process.exit(1);
    }
    return files;
  }

  const directPath = resolve(process.cwd(), arg);
  if (existsSync(directPath)) return [directPath];

  const inDefaultDir = join(DEFAULT_CSV_DIR, arg);
  if (existsSync(inDefaultDir)) return [inDefaultDir];

  console.error(`Ficheiro CSV não encontrado: ${arg} (nem em ${DEFAULT_CSV_DIR})`);
  process.exit(1);
}

const fileArg = process.argv[2];
const calArg = process.argv[3] as CalibrationMode | undefined;
const modeArg = process.argv[4] as TripMode | undefined;

const calibrationMode: CalibrationMode =
  calArg && VALID_CALIBRATION_MODES.has(calArg) ? calArg : 'auto';
const tripMode: TripMode =
  modeArg && VALID_TRIP_MODES.has(modeArg) ? modeArg : 'road';

const targets = resolveCsvTargets(fileArg);

for (const csvPath of targets) {
  const csvText = readFileSync(csvPath, 'utf-8');
  const r = runTelemetryPipeline(csvText, { tripMode, calibrationMode });
  const { summary, vehicleSpecs, kammLimits, calibrationStats } = r;

  console.log(`\n=== ${basename(csvPath)} ===`);
  console.log(
    `Profile     : ${r.profile} | mode=${tripMode} | calibration=${calibrationStats.method}`,
  );
  console.log(
    `Vehicle     : ${vehicleSpecs.name} (${vehicleSpecs.curbMassKg}+${vehicleSpecs.payloadKg}=${vehicleSpecs.grossMassKg} kg, ${vehicleSpecs.powerHp} hp, geom=${vehicleSpecs.geometrySource})`,
  );
  console.log(
    `Kamm Limits : accel=${kammLimits.accelLimit.toFixed(2)}G | brake=${kammLimits.brakeLimit.toFixed(2)}G | lat=${kammLimits.latLimit.toFixed(2)}G | grip=${kammLimits.gripLimitG.toFixed(2)}G`,
  );
  console.log(
    `Samples     : ${summary.sampleCount} | moving=${summary.movingDurationSec.toFixed(1)}s | dist=${summary.totalDistanceKm.toFixed(2)} km | sufficient=${summary.isSufficientData}`,
  );
  console.log(
    `Peaks       : speed=${summary.peakSpeedKmh.toFixed(1)} km/h | +ax=${summary.peakAccelG.toFixed(2)}G | -ax=${summary.peakBrakeG.toFixed(2)}G | |ay|=${summary.peakLatG.toFixed(2)}G`,
  );
  console.log(
    `Physics     : maxMassErr=${summary.maxMassConservationErrorN.toExponential(2)} N | incidents=${summary.incidentCount}`,
  );
  console.log(
    `Score       : ${summary.isSufficientData ? `${summary.finalScore}/100 (${summary.grade} — ${summary.tierLabel})` : 'INSUFFICIENT DATA'}`,
  );
  console.log(
    `Pillars     : ${r.pillars.map((p) => `${p.name.split(' ')[0]}=${p.score}`).join(' | ')}`,
  );

  if (calibrationStats.warning) {
    console.log(`Warning     : ${calibrationStats.warning}`);
  }

  if (r.incidents.length > 0) {
    console.log('Top 5 Incidents:');
    for (const inc of r.incidents.slice(0, 5)) {
      console.log(
        `  - ${inc.timeStr} | ${inc.category} | -${inc.points} pts | ${inc.intensity}`,
      );
    }
  }
}
