/**
 * Fronteira única LABSIS -> ISO 8855 / SI (`m/s²`, `rad/s`, `m/s`).
 * Implementa tara estacionária anti-rampa (Caso A), tara em andamento por mediana (Caso B),
 * modo pré-compensado CSV v2.2 com diagnóstico e rastreio de declive gap-safe (`ALPHA_GRADE = 0.025`).
 *
 * Testes:
 *   npx vitest run test/calibration.test.ts
 */
import type { CalibratedSampleIso, TelemetryPointRaw } from './types.ts';

export type { CalibratedSampleIso };

const GRAVITY = 9.80665;
const DEG_TO_RAD = Math.PI / 180;
const ALPHA_GRADE = 0.025;
const MAX_TARE_SAMPLES = 25;
const MIN_TARE_SAMPLES = 10;
const MAX_TARE_WINDOW_SEC = 30.0;

export type CalibrationProfile = 'labsis_v22_export' | 'generic_iso';
export type CalibrationMode = 'auto' | 'use_csv_compensated' | 'recalibrate_raw';
export type CalibrationMethod =
  | 'stationary_tare'
  | 'moving_median_tare'
  | 'csv_compensated'
  | 'passthrough_iso';

export interface CalibrationOptions {
  profile?: CalibrationProfile;
  mode?: CalibrationMode;
}

export interface CalibrationStats {
  method: CalibrationMethod;
  tareCount: number;
  biasRollX: number;
  initialPitchBiasY: number;
  biasGyroX: number;
  biasGyroY: number;
  biasGyroZ: number;
  warning?: string;
}

export interface CalibrationResult {
  samples: CalibratedSampleIso[];
  stats: CalibrationStats;
}

/**
 * Single boundary between raw/LABSIS telemetry and ISO 8855 / SI units.
 *
 * ISO 8855 conventions:
 * - `+ax`: forward acceleration (`+compensatedLonG * g`) | `-ax`: braking
 * - `+ay`: left turn (`-compensatedLatG * g`) | `-ay`: right turn
 * - `+omegaZ`: counter-clockwise yaw rate in `rad/s`
 */
export function calibrateSamples(
  rawPoints: readonly TelemetryPointRaw[],
  options: CalibrationOptions = {},
): CalibrationResult {
  const profile: CalibrationProfile = options.profile ?? 'labsis_v22_export';
  const mode: CalibrationMode = options.mode ?? 'auto';

  if (rawPoints.length === 0) {
    return {
      samples: [],
      stats: {
        method: profile === 'generic_iso' ? 'passthrough_iso' : 'stationary_tare',
        tareCount: 0,
        biasRollX: 0,
        initialPitchBiasY: 0,
        biasGyroX: 0,
        biasGyroY: 0,
        biasGyroZ: 0,
      },
    };
  }

  // Generic ISO 8855 passthrough (already in ISO sign convention)
  if (profile === 'generic_iso' && mode !== 'recalibrate_raw') {
    const samples: CalibratedSampleIso[] = rawPoints.map((p) => {
      const roadGradePct = p.roadGradePct ?? 0;
      return {
        ax: p.accelX * GRAVITY,
        ay: p.accelY * GRAVITY,
        az: p.accelZ * GRAVITY,
        omegaZ: p.gyroZ * DEG_TO_RAD,
        speedMs: p.speed / 3.6,
        roadGradePct,
        pitchSlopeRad: Math.atan(roadGradePct / 100),
        elapsedSec: p.elapsedSec ?? 0,
        dtSec: p.dtSec ?? 0.2,
        isGap: p.isGap ?? false,
        lat: p.lat,
        lon: p.lon,
        gpsValid: p.gpsValid ?? (p.lat !== null && p.lon !== null),
      };
    });

    return {
      samples,
      stats: {
        method: 'passthrough_iso',
        tareCount: 0,
        biasRollX: 0,
        initialPitchBiasY: 0,
        biasGyroX: 0,
        biasGyroY: 0,
        biasGyroZ: 0,
      },
    };
  }

  const hasCsvCompensated = rawPoints.some(
    (p) => p.accelLatCompG !== undefined && p.accelLonCompG !== undefined,
  );

  if (mode === 'use_csv_compensated' || (mode === 'auto' && hasCsvCompensated)) {
    return calibrateFromCsvCompensated(rawPoints);
  }

  // Case A: Stationary tare only during initial standstill (within first 30 s, before vehicle moves)
  const tareRollX: number[] = [];
  const tarePitchY: number[] = [];
  const tareGyroX: number[] = [];
  const tareGyroY: number[] = [];
  const tareGyroZ: number[] = [];

  let prevGyroX: number | null = null;
  let prevGyroY: number | null = null;
  let prevGyroZ: number | null = null;

  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    if (!p) continue;

    const elapsed = p.elapsedSec ?? i * 0.2;
    if (elapsed > MAX_TARE_WINDOW_SEC || tareRollX.length >= MAX_TARE_SAMPLES) {
      break;
    }

    // Anti-ramp: once the vehicle starts moving, stop collecting stationary tare samples
    if (p.speed >= 0.8) {
      break;
    }

    const normA = Math.hypot(p.accelX, p.accelY, p.accelZ);
    const gx = p.gyroX ?? 0;
    const gy = p.gyroY ?? 0;
    const gz = p.gyroZ;

    const gyroStable =
      prevGyroZ === null ||
      (Math.abs(gx - (prevGyroX ?? 0)) < 0.5 &&
        Math.abs(gy - (prevGyroY ?? 0)) < 0.5 &&
        Math.abs(gz - prevGyroZ) < 0.5);

    prevGyroX = gx;
    prevGyroY = gy;
    prevGyroZ = gz;

    if (
      Math.abs(p.accelX) < 0.35 &&
      Math.abs(p.accelY) < 0.35 &&
      normA >= 0.85 &&
      normA <= 1.15 &&
      gyroStable
    ) {
      tareRollX.push(p.accelX);
      tarePitchY.push(p.accelY);
      tareGyroX.push(gx);
      tareGyroY.push(gy);
      tareGyroZ.push(gz);
    }
  }

  let method: CalibrationMethod;
  let biasRollX = 0;
  let initialPitchBiasY = 0;
  let biasGyroX = 0;
  let biasGyroY = 0;
  let biasGyroZ = 0;
  const tareCount = tareRollX.length;

  if (tareCount >= MIN_TARE_SAMPLES) {
    method = 'stationary_tare';
    biasRollX = mean(tareRollX);
    initialPitchBiasY = mean(tarePitchY);
    biasGyroX = mean(tareGyroX);
    biasGyroY = mean(tareGyroY);
    biasGyroZ = mean(tareGyroZ);
  } else {
    // Case B: Moving median tare on steady straight segments (anti-ramp regression 175207)
    // Prefer startup window (first 30 s) when >= 10 steady straight samples exist so
    // later hills do not bias the initial pitch tare.
    method = 'moving_median_tare';
    const startupPitchSamples: number[] = [];
    const startupRollSamples: number[] = [];
    const allPitchSamples: number[] = [];
    const allRollSamples: number[] = [];

    for (let i = 1; i < rawPoints.length; i++) {
      const curr = rawPoints[i];
      const prev = rawPoints[i - 1];
      if (!curr || !prev) continue;

      const isGap = curr.isGap ?? false;
      const dt = curr.dtSec ?? 0.2;
      if (isGap || dt <= 0) continue;

      const u = curr.speed / 3.6;
      const prevU = prev.speed / 3.6;
      const duDt = (u - prevU) / dt;

      if (u > 4.0 && Math.abs(curr.gyroZ) < 3.0 && Math.abs(duDt) < 1.5) {
        const omegaZRad = curr.gyroZ * DEG_TO_RAD;
        const pitchVal = curr.accelY - duDt / GRAVITY;
        const rollVal = curr.accelX + (u * omegaZRad) / GRAVITY;
        allPitchSamples.push(pitchVal);
        allRollSamples.push(rollVal);

        const elapsed = curr.elapsedSec ?? i * 0.2;
        if (elapsed <= MAX_TARE_WINDOW_SEC) {
          startupPitchSamples.push(pitchVal);
          startupRollSamples.push(rollVal);
        }
      }
    }

    const useStartup = startupPitchSamples.length >= MIN_TARE_SAMPLES;
    initialPitchBiasY = median(useStartup ? startupPitchSamples : allPitchSamples);
    biasRollX = median(useStartup ? startupRollSamples : allRollSamples);
  }

  // Dynamic road-grade tracking (gap-safe) + single ISO 8855 / SI transformation
  const samples: CalibratedSampleIso[] = [];
  let dynamicPitchBiasY = initialPitchBiasY;
  let prevSpeedMs = (rawPoints[0]?.speed ?? 0) / 3.6;

  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    if (!p) continue;

    const dt = p.dtSec ?? 0.2;
    const isGap = p.isGap ?? false;
    const speedMs = p.speed / 3.6;
    const gyroZComp = p.gyroZ - biasGyroZ;

    const gpsKinematicG =
      !isGap && i > 0 && dt > 0 ? (speedMs - prevSpeedMs) / dt / GRAVITY : 0;
    const apparentGravityY = p.accelY - gpsKinematicG;

    if (
      !isGap &&
      i > 0 &&
      dt > 0 &&
      Math.abs(gyroZComp) < 8.0 &&
      Math.abs(gpsKinematicG) < 0.35 &&
      p.speed > 10.0 &&
      Math.abs(apparentGravityY - dynamicPitchBiasY) < 0.25
    ) {
      dynamicPitchBiasY += ALPHA_GRADE * (apparentGravityY - dynamicPitchBiasY);
    }

    const compensatedLonG = p.accelY - dynamicPitchBiasY;
    const compensatedLatG = p.accelX - biasRollX;

    const slopeSin = clamp(dynamicPitchBiasY - initialPitchBiasY, -0.99, 0.99);
    const pitchSlopeRad = Math.asin(slopeSin);
    const roadGradePct = Math.tan(pitchSlopeRad) * 100;

    samples.push({
      ax: compensatedLonG * GRAVITY,
      ay: -compensatedLatG * GRAVITY,
      az: p.accelZ * GRAVITY,
      omegaZ: gyroZComp * DEG_TO_RAD,
      speedMs,
      roadGradePct,
      pitchSlopeRad,
      elapsedSec: p.elapsedSec ?? i * 0.2,
      dtSec: dt,
      isGap,
      lat: p.lat,
      lon: p.lon,
      gpsValid: p.gpsValid ?? (p.lat !== null && p.lon !== null),
    });

    prevSpeedMs = speedMs;
  }

  return {
    samples,
    stats: {
      method,
      tareCount,
      biasRollX,
      initialPitchBiasY,
      biasGyroX,
      biasGyroY,
      biasGyroZ,
    },
  };
}

function calibrateFromCsvCompensated(
  rawPoints: readonly TelemetryPointRaw[],
): CalibrationResult {
  const samples: CalibratedSampleIso[] = [];
  const startupDiffs: number[] = [];
  let prevSpeedMs = (rawPoints[0]?.speed ?? 0) / 3.6;

  for (let i = 0; i < rawPoints.length; i++) {
    const p = rawPoints[i];
    if (!p) continue;

    const dt = p.dtSec ?? 0.2;
    const isGap = p.isGap ?? false;
    const elapsedSec = p.elapsedSec ?? i * 0.2;
    const speedMs = p.speed / 3.6;
    const lonCompG = p.accelLonCompG ?? p.accelY;
    const latCompG = p.accelLatCompG ?? p.accelX;
    const roadGradePct = p.roadGradePct ?? 0;

    if (!isGap && i > 0 && dt > 0 && elapsedSec <= MAX_TARE_WINDOW_SEC && speedMs > 4.0) {
      const gpsKinematicG = (speedMs - prevSpeedMs) / dt / GRAVITY;
      startupDiffs.push(lonCompG - gpsKinematicG);
    }

    samples.push({
      ax: lonCompG * GRAVITY,
      ay: -latCompG * GRAVITY,
      az: p.accelZ * GRAVITY,
      omegaZ: p.gyroZ * DEG_TO_RAD,
      speedMs,
      roadGradePct,
      pitchSlopeRad: Math.atan(roadGradePct / 100),
      elapsedSec,
      dtSec: dt,
      isGap,
      lat: p.lat,
      lon: p.lon,
      gpsValid: p.gpsValid ?? (p.lat !== null && p.lon !== null),
    });

    prevSpeedMs = speedMs;
  }

  let warning: string | undefined;
  if (startupDiffs.length >= MIN_TARE_SAMPLES) {
    const avgDiff = mean(startupDiffs);
    if (Math.abs(avgDiff) > 0.08) {
      warning = `Systematic divergence between accel_lon_comp_g and du/dt at startup (${avgDiff.toFixed(3)} G)`;
    }
  }

  return {
    samples,
    stats: {
      method: 'csv_compensated',
      tareCount: 0,
      biasRollX: 0,
      initialPitchBiasY: 0,
      biasGyroX: 0,
      biasGyroY: 0,
      biasGyroZ: 0,
      ...(warning !== undefined ? { warning } : {}),
    },
  };
}

function mean(values: readonly number[]): number {
  if (values.length === 0) return 0;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid] ?? 0;
  }
  return ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
