import type { KammLimits, TripMode, VehicleSpecs } from './types.ts';

const GRAVITY = 9.80665;
const MM_PER_INCH = 25.4;
const DEFAULT_TIRE_RADIUS_M = 0.316;
const HP_TO_WATTS = 745.7;
const REF_SPEED_MS = 15.0;

const MIN_ACCEL_G = 0.32;
const MIN_BRAKE_G = 0.40;
const MIN_LAT_G = 0.40;

/**
 * Parses a commercial tire size string (e.g. "195/55 R16") and returns
 * the nominal outer radius in meters.
 */
export function calculateTireRadius(tireSize: string): number {
  const match = tireSize.match(/(\d+)\s*\/\s*(\d+)\s*[Rr]\s*(\d+)/);
  if (!match) {
    return DEFAULT_TIRE_RADIUS_M;
  }

  const widthMm = Number(match[1]);
  const aspectRatio = Number(match[2]);
  const rimDiameterIn = Number(match[3]);

  const sidewallMm = widthMm * (aspectRatio / 100);
  const rimRadiusMm = (rimDiameterIn * MM_PER_INCH) / 2;
  return (rimRadiusMm + sidewallMm) / 1000;
}

/**
 * Computes dynamic Kamm friction circle limits (in G) from vehicle specs and
 * trip mode, enforcing minimum road floors (0.32 / 0.40 / 0.40 G) and the
 * braking invariant (brakeLimit >= accelLimit).
 */
export function computeDynamicKammLimits(
  specs: VehicleSpecs,
  mode: TripMode,
): KammLimits {
  const gripLimitG = specs.surfaceGrip > 0 ? specs.surfaceGrip : 0.95;
  const isCompetition = mode === 'competition';

  const latScale = isCompetition ? 0.95 : 0.75;
  const brakeScale = isCompetition ? 1.0 : 0.80;
  const accelScale = isCompetition ? 0.85 : 0.65;

  const powerWatts = specs.powerHp * HP_TO_WATTS;
  const massKg = Math.max(1, specs.grossMassKg);
  const powerAccelG = powerWatts / (massKg * REF_SPEED_MS * GRAVITY);

  const latLimit = Math.max(MIN_LAT_G, Math.min(gripLimitG, gripLimitG * latScale));
  const accelLimit = Math.max(MIN_ACCEL_G, Math.min(powerAccelG, gripLimitG * accelScale));
  const rawBrake = Math.max(MIN_BRAKE_G, Math.min(gripLimitG, gripLimitG * brakeScale));
  const brakeLimit = Math.max(rawBrake, accelLimit);

  return {
    accelLimit,
    brakeLimit,
    latLimit,
    gripLimitG,
  };
}
