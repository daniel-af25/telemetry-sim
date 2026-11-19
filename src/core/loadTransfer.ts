/**
 * Transferência de carga quase-estática nas 4 rodas (`Fz`), direção cinemática Bloco C
 * (rampa `w_u`, `max(u, 1.0)`, clamp `±maxSteerRad`), atitude ISO 8855 (`rollRad`, `pitchRad`),
 * forças horizontais por roda (`Fx`, `Fy`) e momento de guinada (`yawMoment`, N·m).
 *
 * Testes:
 *   npx vitest run test/loadTransfer.test.ts
 */
import type { LoadTransferResult, VehicleSpecs } from './types.ts';

const GRAVITY = 9.80665;
const STEER_DEADZONE_MS = 0.3;
const STEER_RAMP_SPAN_MS = 1.2;
const STEER_MIN_DENOM_MS = 1.0;
const DEFAULT_MAX_STEER_RAD = (35 * Math.PI) / 180; // ~0.6109 rad

/**
 * Computes quasi-static 4-wheel vertical tire loads (Fz), Block C low-speed
 * kinematic steering angle, body roll/pitch angles, per-wheel horizontal tire
 * forces (Fx, Fy), and net yaw moment (N·m).
 *
 * ISO 8855 / `view3d.py` sign conventions:
 * - `+ax`: forward acceleration | `-ax`: braking
 * - `+ay`: left turn | `-ay`: right turn
 * - `+omegaZ`: counter-clockwise (left) yaw rate in rad/s
 * - `rollRad > 0`: right side down (left turn `+ay`)
 * - `pitchRad > 0`: nose down (braking `-ax`)
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

  // Block C low-speed steering kinematics:
  // w_u = clamp((u - 0.3) / 1.2, 0, 1)
  // delta = clamp(atan(L * (omegaZ * w_u) / max(u, 1.0)), -deltaMax, +deltaMax)
  const wu = clamp((speed - STEER_DEADZONE_MS) / STEER_RAMP_SPAN_MS, 0, 1);
  const maxSteer =
    specs.maxSteerRad !== undefined && Number.isFinite(specs.maxSteerRad) && specs.maxSteerRad > 0
      ? specs.maxSteerRad
      : DEFAULT_MAX_STEER_RAD;
  const denom = Math.max(speed, STEER_MIN_DENOM_MS);
  const steerRad =
    wu === 0 ? 0.0 : clamp(Math.atan((specs.wheelbaseL * (omegaZ * wu)) / denom), -maxSteer, maxSteer);

  // ISO 8855 / view3d.py body attitude:
  // rollRad > 0 = right side down (+ay left turn); pitchRad > 0 = nose down (-ax braking)
  const rollRad = (ay / GRAVITY) * 0.05;
  const pitchRad = -(ax / GRAVITY) * 0.03;

  // Per-wheel horizontal forces distributed proportionally to normal load Fz
  const totalFx = specs.grossMassKg * ax;
  const totalFy = specs.grossMassKg * ay;
  const invWeight = totalWeight > 0 ? 1 / totalWeight : 0;

  const wFL = fzFL * invWeight;
  const wFR = fzFR * invWeight;
  const wRL = fzRL * invWeight;
  const wRR = fzRR * invWeight;

  const fxFL = totalFx * wFL;
  const fxFR = totalFx * wFR;
  const fxRL = totalFx * wRL;
  const fxRR = totalFx * wRR;

  const fyFL = totalFy * wFL;
  const fyFR = totalFy * wFR;
  const fyRL = totalFy * wRL;
  const fyRR = totalFy * wRR;

  // Net yaw moment around CG (+Mz counter-clockwise in ISO 8855)
  const lr = specs.wheelbaseL * specs.frontWeightRatio;
  const lf = specs.wheelbaseL - lr;
  const halfTrackF = specs.trackF * 0.5;
  const halfTrackR = specs.trackR * 0.5;
  const yawMoment =
    lf * (fyFL + fyFR) -
    lr * (fyRL + fyRR) +
    halfTrackF * (fxFR - fxFL) +
    halfTrackR * (fxRR - fxRL);

  return {
    fzFL,
    fzFR,
    fzRL,
    fzRR,
    fxFL,
    fxFR,
    fxRL,
    fxRR,
    fyFL,
    fyFR,
    fyRL,
    fyRR,
    yawMoment,
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

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
