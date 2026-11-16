import type { LoadTransferResult, VehicleSpecs } from './types.ts';

const GRAVITY = 9.80665;
const LOW_SPEED_RAMP_MS = 2.0;

/**
 * Computes quasi-static 4-wheel vertical tire loads (Fz), kinematic steering
 * angle with low-speed damping ramp w_u, and body roll/pitch estimates using
 * ISO 8855 sign conventions (+ax forward, +ay left turn, +omegaZ CCW).
 */
export function computeLoadTransfer(
  ax: number,
  ay: number,
  speed: number,
  omegaZ: number,
  specs: VehicleSpecs,
): LoadTransferResult {
  const totalWeight = specs.grossMassKg * GRAVITY;
  const frontStatic = totalWeight * specs.frontWeightRatio;
  const rearStatic = totalWeight - frontStatic;

  // Longitudinal load transfer (+ax transfers load from front to rear)
  const deltaFzLong = (specs.grossMassKg * ax * specs.cgHeight) / specs.wheelbaseL;
  let fzFront = frontStatic - deltaFzLong;
  let fzRear = rearStatic + deltaFzLong;

  // Clamp at axle level while strictly preserving total mass (fzFront + fzRear === totalWeight)
  if (fzFront < 0) {
    fzFront = 0;
    fzRear = totalWeight;
  } else if (fzRear < 0) {
    fzRear = 0;
    fzFront = totalWeight;
  }

  // Lateral load transfer (+ay left turn loads outer right wheels FR/RR)
  const lateralMoment = specs.grossMassKg * ay * specs.cgHeight;
  const deltaFzLatFront = (lateralMoment * specs.frontRollShare) / specs.trackF;
  const deltaFzLatRear = (lateralMoment * (1 - specs.frontRollShare)) / specs.trackR;

  const [fzFL, fzFR] = splitAxle(fzFront, deltaFzLatFront);
  const [fzRL, fzRR] = splitAxle(fzRear, deltaFzLatRear);

  // Low-speed damping ramp w_u to avoid division by zero as speed -> 0
  const u = Math.max(0, speed);
  const wu = u <= 0 ? 0 : Math.min(1, u / LOW_SPEED_RAMP_MS);
  const steerRad = wu === 0 ? 0.0 : wu * Math.atan((specs.wheelbaseL * omegaZ) / u);

  const rollRad = (ay / GRAVITY) * 0.05;
  const pitchRad = -(ax / GRAVITY) * 0.03;

  return {
    fzFL,
    fzFR,
    fzRL,
    fzRR,
    steerRad,
    rollRad,
    pitchRad,
  };
}

/**
 * Splits axle vertical load between left and right wheels while clamping
 * lifted wheels at 0 N and shifting the remaining load to the opposite wheel.
 */
function splitAxle(axleFz: number, deltaLat: number): [number, number] {
  const half = axleFz * 0.5;
  let left = half - deltaLat;
  let right = half + deltaLat;

  if (left < 0) {
    left = 0;
    right = axleFz;
  } else if (right < 0) {
    right = 0;
    left = axleFz;
  }

  return [left, right];
}
