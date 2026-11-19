import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseCsv } from '../src/core/parser.ts';
import { parseVehiclesCsv } from '../src/core/vehicleCatalog.ts';
import { calculateTireRadius, computeDynamicKammLimits } from '../src/core/kamm.ts';
import { computeLoadTransfer } from '../src/core/loadTransfer.ts';
import {
  clusterDebouncedIncidents,
  evaluateIncidentSlip,
  hasMinimumMovingData,
  type IncidentCandidate,
} from '../src/core/scoring.ts';
import type { VehicleSpecs } from '../src/core/types.ts';

const GRAVITY = 9.80665;
const DEG_TO_RAD = Math.PI / 180;

const tripPath = resolve(process.cwd(), process.argv[2] ?? 'test/fixtures/trip_test.csv');
const vehiclesPath = resolve(process.cwd(), 'src/data/vehicles.csv');
const requestedVehicleId = process.argv[3] ? Number(process.argv[3]) : undefined;

const catalog = parseVehiclesCsv(readFileSync(vehiclesPath, 'utf-8'));

const selectedEntry =
  (requestedVehicleId !== undefined ? catalog.get(requestedVehicleId) : undefined) ??
  Array.from(catalog.values()).find((v) => v.weight_kg && v.power_hp && v.tire_size);

if (!selectedEntry) {
  throw new Error('No suitable vehicle found in src/data/vehicles.csv');
}

const tireSize = selectedEntry.tire_size ?? '205/55 R16';
const curbMassKg = selectedEntry.weight_kg ?? 1400;
const payloadKg = 100;
const specs: VehicleSpecs = {
  id: selectedEntry.id,
  name: `${selectedEntry.make} ${selectedEntry.model}`,
  grossMassKg: selectedEntry.gross_weight_kg ?? curbMassKg + payloadKg,
  curbMassKg,
  payloadKg,
  powerHp: selectedEntry.power_hp ?? 150,
  wheelbaseL: 2.65,
  trackF: 1.55,
  trackR: 1.55,
  cgHeight: 0.54,
  frontWeightRatio: 0.58,
  frontRollShare: 0.58,
  tireSize,
  tireRadiusM: calculateTireRadius(tireSize),
  surfaceGrip: 0.95,
};

const parsed = parseCsv(readFileSync(tripPath, 'utf-8'));
const limits = computeDynamicKammLimits(specs, 'road');

let maxSpeedKmh = 0;
let maxAccelG = -Infinity;
let minAccelG = Infinity;
let maxLatG = 0;
let minFz = Infinity;
let maxFz = -Infinity;
let maxMassErr = 0;
let slipCount = 0;
let movingSamples = 0;

const incidents: Array<IncidentCandidate & { timestamp: number; rawTime: string }> = [];
const theoreticalWeight = specs.grossMassKg * GRAVITY;

for (let i = 0; i < parsed.data.length; i++) {
  const p = parsed.data[i];
  const speedMs = p.speed / 3.6;
  const ax = p.accelX * GRAVITY;
  const ay = p.accelY * GRAVITY;
  const omegaZ = p.gyroZ * DEG_TO_RAD;

  if (p.speed > 1) movingSamples++;
  if (p.speed > maxSpeedKmh) maxSpeedKmh = p.speed;
  if (p.accelX > maxAccelG) maxAccelG = p.accelX;
  if (p.accelX < minAccelG) minAccelG = p.accelX;
  if (Math.abs(p.accelY) > maxLatG) maxLatG = Math.abs(p.accelY);

  const lt = computeLoadTransfer(ax, ay, speedMs, omegaZ, specs);
  const fzValues = [lt.fzFL, lt.fzFR, lt.fzRL, lt.fzRR];
  for (const fz of fzValues) {
    if (fz < minFz) minFz = fz;
    if (fz > maxFz) maxFz = fz;
  }

  const totalFz = lt.fzFL + lt.fzFR + lt.fzRL + lt.fzRR;
  const massErr = Math.abs(totalFz - theoreticalWeight);
  if (massErr > maxMassErr) maxMassErr = massErr;

  const tSec = i * 0.2;
  const isSlip = evaluateIncidentSlip(ay, speedMs, omegaZ);
  if (isSlip) {
    slipCount++;
    incidents.push({
      category: 'slip',
      points: 5,
      excessRatio: 1.2,
      timestamp: tSec,
      rawTime: String(p.timestamp),
    });
  }

  if (p.accelX < -limits.brakeLimit) {
    const ratio = Math.abs(p.accelX) / limits.brakeLimit;
    incidents.push({
      category: 'braking',
      points: ratio > 1.3 ? 7 : 3,
      excessRatio: ratio,
      timestamp: tSec,
      rawTime: String(p.timestamp),
    });
  } else if (Math.abs(p.accelY) > limits.latLimit) {
    const ratio = Math.abs(p.accelY) / limits.latLimit;
    incidents.push({
      category: 'lateral',
      points: ratio > 1.3 ? 6 : 2,
      excessRatio: ratio,
      timestamp: tSec,
      rawTime: String(p.timestamp),
    });
  }
}

const clustered = clusterDebouncedIncidents(incidents);
const movingSeconds = movingSamples * 0.2;

console.log('=== TELEMETRY TRIP ANALYSIS ===');
console.log(`Vehicle        : #${specs.id} ${specs.name} (${specs.grossMassKg} kg, ${specs.powerHp} hp, ${specs.tireSize}, R=${specs.tireRadiusM.toFixed(4)} m)`);
console.log(`Catalog loaded : ${catalog.size} vehicles`);
console.log(`Trip samples   : ${parsed.data.length} (scalingFactor=${parsed.scalingFactor}, extraChannels=[${parsed.extraChannels.join(', ')}])`);
console.log(`Moving time    : ${movingSeconds.toFixed(1)} s (valid >= 300 s: ${hasMinimumMovingData(movingSeconds)})`);
console.log(`Max speed      : ${maxSpeedKmh.toFixed(1)} km/h`);
console.log(`G range        : ax [${minAccelG.toFixed(3)}, ${maxAccelG.toFixed(3)}] G | max |ay| ${maxLatG.toFixed(3)} G`);
console.log(`Kamm (road)    : accel=${limits.accelLimit.toFixed(2)}G, brake=${limits.brakeLimit.toFixed(2)}G, lat=${limits.latLimit.toFixed(2)}G`);
console.log(`Fz wheel range : [${minFz.toFixed(1)}, ${maxFz.toFixed(1)}] N | max mass conservation error: ${maxMassErr.toExponential(2)} N`);
console.log(`Slip samples   : ${slipCount} | Debounced incidents (1.0s): ${clustered.length}`);

if (clustered.length > 0) {
  console.log('\nTop 5 worst incidents:');
  const top5 = [...clustered]
    .sort((a, b) => b.points - a.points || b.excessRatio - a.excessRatio)
    .slice(0, 5);
  for (const inc of top5) {
    console.log(
      `  - t=${inc.timestamp.toFixed(1)}s (${inc.rawTime}) | ${inc.category} | points=${inc.points} | ratio=${inc.excessRatio.toFixed(2)}`,
    );
  }
}
