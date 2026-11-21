/**
 * Módulo 100% puro de matemática, escalas físicas e colormaps para o Lab Dinâmico ao Vivo
 * (2D Top-Down `topdown.py` e 3D Isométrico `view3d.py`).
 *
 * - Zero DOM, zero WebGL, 100% testável em Vitest/Node.js.
 * - Convenção ISO 8855 estrita (`+ax` frente, `+ay` esquerda, `+omegaZ` CCW,
 *   `+roll` lado direito em baixo, `+pitch` nariz em baixo).
 * - Escala métrica unificada `forceScale = FORCE_ARROW_M / maxFz` (m/N) idêntica a `view3d.py`.
 *
 * Testes:
 *   npx vitest run test/ui/labTelemetryMath.test.ts
 */
import type { SampleFrame } from '../core/interpolator.ts';
import { computeLoadTransfer } from '../core/loadTransfer.ts';
import type { TelemetryTrackSoA } from '../core/soa.ts';
import type { KammLimits } from '../core/types.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';
import { RDYLGN_R_PALETTE } from './mapView.ts';

const GRAVITY_MS2 = 9.80665;
const RAD_TO_DEG = 180 / Math.PI;
const DEFAULT_MAX_STEER_RAD = (35 * Math.PI) / 180;

// Constantes de visualização fiéis a rallysim-master tools/view3d.py e tools/topdown.py
export const OVERHANG_M = 0.8;
export const BODY_WIDTH_MARGIN_M = 0.25;
export const BODY_TOP_M = 0.75;
export const STRUT_LENGTH_M = 0.35;
export const VELOCITY_TIME_S = 0.15;
export const FORCE_ARROW_M = 1.2;
export const LOAD_OFFSET_M = 0.28;
export const YAW_ARC_RADIUS_M = 0.9;
export const YAW_ARC_MAX_SWEEP_RAD = (270 * Math.PI) / 180;
export const ISO_ELEV_RAD = Math.atan(1 / Math.sqrt(2));
export const ISO_AZIM_RAD = -Math.PI / 4;
export const TRAIL_2D_SEC = 3.0;
export const TRAIL_3D_SEC = 4.0;
export const GG_TRAIL_SEC = 2.0;

export type LabWheelId = 'FL' | 'FR' | 'RL' | 'RR';
export const LAB_WHEEL_IDS: readonly LabWheelId[] = ['FL', 'FR', 'RL', 'RR'] as const;

export type LabWheelStateLabel = '' | 'no ar' | 'slip' | 'limite';

export interface LabRunScales {
  staticFzFL: number;
  staticFzFR: number;
  staticFzRL: number;
  staticFzRR: number;
  maxFz: number;
  forceScale: number;
  momentMax: number;
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  maxSpeedKmh: number;
  maxAbsYawRateDegS: number;
  maxAbsAyG: number;
}

export interface LabWheelDynamics {
  id: LabWheelId;
  wx: number;
  wy: number;
  fx: number;
  fy: number;
  fz: number;
  grip: number;
  gripUse: number;
  gripUseClamped: number;
  strutRatio: number;
  stateLabel: LabWheelStateLabel;
}

export interface LabFrameDynamics {
  lf: number;
  lr: number;
  trackF: number;
  trackR: number;
  cgHeight: number;
  tireRadiusM: number;
  wheels: Record<LabWheelId, LabWheelDynamics>;
  netFx: number;
  netFy: number;
  yawMoment: number;
  momentShare: number;
  throttle: number;
  brake: number;
  steerRad: number;
  maxSteerRad: number;
  steerNorm: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function parseHexRgb(hex: string): [number, number, number] {
  const clean = hex.startsWith('#') ? hex.slice(1) : hex;
  if (clean.length !== 6) return [16, 185, 129];
  const r = Number.parseInt(clean.slice(0, 2), 16);
  const g = Number.parseInt(clean.slice(2, 4), 16);
  const b = Number.parseInt(clean.slice(4, 6), 16);
  return [
    Number.isFinite(r) ? r : 16,
    Number.isFinite(g) ? g : 185,
    Number.isFinite(b) ? b : 129,
  ];
}

function rgbToHex(r: number, g: number, b: number): string {
  const cr = clamp(Math.round(r), 0, 255);
  const cg = clamp(Math.round(g), 0, 255);
  const cb = clamp(Math.round(b), 0, 255);
  return `#${cr.toString(16).padStart(2, '0')}${cg.toString(16).padStart(2, '0')}${cb.toString(16).padStart(2, '0')}`;
}

const RDYLGN_RGB: ReadonlyArray<readonly [number, number, number]> =
  RDYLGN_R_PALETTE.map(parseHexRgb);

/**
 * Continuous RGB interpolation across `RDYLGN_R_PALETTE` clamped to `[0, 1]`.
 * `0` -> emerald green (`#10b981`), `0.5` -> yellow, `1` -> crimson red (`#f43f5e`).
 */
export function gripColorHex(use: number): string {
  const t = clamp(Number.isFinite(use) ? use : 0, 0, 1);
  const lastIdx = RDYLGN_RGB.length - 1;
  if (lastIdx <= 0) return '#10b981';

  const scaled = t * lastIdx;
  const i0 = Math.min(lastIdx, Math.floor(scaled));
  const i1 = Math.min(lastIdx, i0 + 1);
  const frac = scaled - i0;

  const c0 = RDYLGN_RGB[i0] ?? [16, 185, 129];
  const c1 = RDYLGN_RGB[i1] ?? c0;
  return rgbToHex(
    c0[0] + (c1[0] - c0[0]) * frac,
    c0[1] + (c1[1] - c0[1]) * frac,
    c0[2] + (c1[2] - c0[2]) * frac,
  );
}

const COOLWARM_LOW: readonly [number, number, number] = [59, 130, 246]; // #3b82f6
const COOLWARM_MID: readonly [number, number, number] = [226, 232, 240]; // #e2e8f0
const COOLWARM_HIGH: readonly [number, number, number] = [239, 68, 68]; // #ef4444

/**
 * Piecewise linear coolwarm colormap faithful to `view3d.py`'s `cm.coolwarm`:
 * `0` -> `#3b82f6` (unloaded), `0.5` -> `#e2e8f0` (static), `1` -> `#ef4444` (loaded).
 */
export function coolwarmColorHex(t: number): string {
  const clamped = clamp(Number.isFinite(t) ? t : 0.5, 0, 1);
  if (clamped <= 0.5) {
    const f = clamped * 2;
    return rgbToHex(
      COOLWARM_LOW[0] + (COOLWARM_MID[0] - COOLWARM_LOW[0]) * f,
      COOLWARM_LOW[1] + (COOLWARM_MID[1] - COOLWARM_LOW[1]) * f,
      COOLWARM_LOW[2] + (COOLWARM_MID[2] - COOLWARM_LOW[2]) * f,
    );
  }
  const f = (clamped - 0.5) * 2;
  return rgbToHex(
    COOLWARM_MID[0] + (COOLWARM_HIGH[0] - COOLWARM_MID[0]) * f,
    COOLWARM_MID[1] + (COOLWARM_HIGH[1] - COOLWARM_MID[1]) * f,
    COOLWARM_MID[2] + (COOLWARM_HIGH[2] - COOLWARM_MID[2]) * f,
  );
}

/**
 * Binary search returning the largest index `i` with `tArr[i] <= targetSec` (clamped to `[0, n-1]`).
 */
export function findTrackIndexAtOrBefore(tArr: Float64Array, targetSec: number): number {
  const n = tArr.length;
  if (n === 0) return -1;
  if (targetSec <= (tArr[0] ?? 0)) return 0;
  if (targetSec >= (tArr[n - 1] ?? 0)) return n - 1;

  let lo = 0;
  let hi = n - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >>> 1;
    if ((tArr[mid] ?? 0) <= targetSec) {
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return Math.max(0, hi);
}

/**
 * Precomputes session-wide Lab scales once per CSV load or What-If reprocess:
 * static wheel loads, unified `forceScale = FORCE_ARROW_M / maxFz`, `momentMax`,
 * ENU bounding box, and 2D time-series extrema.
 */
export function computeLabRunScales(
  track: TelemetryTrackSoA,
  specs: ResolvedVehicleSpecs,
): LabRunScales {
  const staticLt = computeLoadTransfer(0, 0, 0, 0, specs);
  const staticWeightN = Math.max(0, specs.grossMassKg * GRAVITY_MS2);

  let maxFz = 0;
  let momentMax = 0;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let maxSpeedKmh = 0;
  let maxAbsYawRateDegS = 0;
  let maxAbsAyG = 0;

  const n = track.length;
  for (let i = 0; i < n; i++) {
    const fzFL = track.fzFL[i] ?? 0;
    const fzFR = track.fzFR[i] ?? 0;
    const fzRL = track.fzRL[i] ?? 0;
    const fzRR = track.fzRR[i] ?? 0;

    if (fzFL > maxFz) maxFz = fzFL;
    if (fzFR > maxFz) maxFz = fzFR;
    if (fzRL > maxFz) maxFz = fzRL;
    if (fzRR > maxFz) maxFz = fzRR;

    const x = track.x[i] ?? 0;
    const y = track.y[i] ?? 0;
    if (Number.isFinite(x) && Number.isFinite(y)) {
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }

    const speedMs = track.speedMs[i] ?? 0;
    const speedKmh = Math.abs(speedMs) * 3.6;
    if (speedKmh > maxSpeedKmh) maxSpeedKmh = speedKmh;

    const omegaZ = track.omegaZ[i] ?? 0;
    const yawDegS = Math.abs(omegaZ * RAD_TO_DEG);
    if (yawDegS > maxAbsYawRateDegS) maxAbsYawRateDegS = yawDegS;

    const ax = track.ax[i] ?? 0;
    const ay = track.ay[i] ?? 0;
    const ayG = Math.abs(ay / GRAVITY_MS2);
    if (ayG > maxAbsAyG) maxAbsAyG = ayG;

    const lt = computeLoadTransfer(ax, ay, speedMs, omegaZ, specs);
    const absM = Math.abs(lt.yawMoment);
    if (Number.isFinite(absM) && absM > momentMax) {
      momentMax = absM;
    }
  }

  const resolvedMaxFz = maxFz > 1e-6 ? maxFz : staticWeightN;
  const forceScale = resolvedMaxFz > 1e-6 ? FORCE_ARROW_M / resolvedMaxFz : 1e-3;
  const resolvedMomentMax = momentMax > 1e-6 ? momentMax : 1;

  return {
    staticFzFL: staticLt.fzFL,
    staticFzFR: staticLt.fzFR,
    staticFzRL: staticLt.fzRL,
    staticFzRR: staticLt.fzRR,
    maxFz: resolvedMaxFz,
    forceScale,
    momentMax: resolvedMomentMax,
    minX: Number.isFinite(minX) ? minX : -10,
    maxX: Number.isFinite(maxX) ? maxX : 10,
    minY: Number.isFinite(minY) ? minY : -10,
    maxY: Number.isFinite(maxY) ? maxY : 10,
    maxSpeedKmh: Math.max(10, maxSpeedKmh),
    maxAbsYawRateDegS: Math.max(10, maxAbsYawRateDegS),
    maxAbsAyG: Math.max(0.5, maxAbsAyG),
  };
}

/**
 * Computes instantaneous 4-wheel tire forces, grip utilization, strut coolwarm ratios,
 * CG net force, yaw moment share, and normalized driver inputs for a single 60 FPS frame.
 */
export function computeLabFrameDynamics(
  frame: SampleFrame,
  specs: ResolvedVehicleSpecs,
  limits: KammLimits,
  scales: LabRunScales,
): LabFrameDynamics {
  const L = Math.max(1.5, finiteOr(specs.wheelbaseL, 2.65));
  const frontWeightRatio = clamp(finiteOr(specs.frontWeightRatio, 0.58), 0.2, 0.8);
  const lr = L * frontWeightRatio;
  const lf = L - lr;
  const trackF = Math.max(1.0, finiteOr(specs.trackF, 1.55));
  const trackR = Math.max(1.0, finiteOr(specs.trackR, 1.55));
  const cgHeight = Math.max(0.2, finiteOr(specs.cgHeight, 0.54));
  const tireRadiusM = Math.max(0.15, finiteOr(specs.tireRadiusM, 0.316));
  const mu = clamp(finiteOr(specs.surfaceGrip, limits.gripLimitG || 0.95), 0.05, 2.5);

  const ax = finiteOr(frame.ax, 0);
  const ay = finiteOr(frame.ay, 0);
  const speedMs = Math.max(0, finiteOr(frame.speedMs, 0));
  const omegaZ = finiteOr(frame.omegaZ, 0);

  const lt = computeLoadTransfer(ax, ay, speedMs, omegaZ, specs);

  const fzMap: Record<LabWheelId, number> = {
    FL: Math.max(0, finiteOr(frame.fzFL, lt.fzFL)),
    FR: Math.max(0, finiteOr(frame.fzFR, lt.fzFR)),
    RL: Math.max(0, finiteOr(frame.fzRL, lt.fzRL)),
    RR: Math.max(0, finiteOr(frame.fzRR, lt.fzRR)),
  };
  const staticMap: Record<LabWheelId, number> = {
    FL: scales.staticFzFL,
    FR: scales.staticFzFR,
    RL: scales.staticFzRL,
    RR: scales.staticFzRR,
  };
  const fxMap: Record<LabWheelId, number> = {
    FL: lt.fxFL,
    FR: lt.fxFR,
    RL: lt.fxRL,
    RR: lt.fxRR,
  };
  const fyMap: Record<LabWheelId, number> = {
    FL: lt.fyFL,
    FR: lt.fyFR,
    RL: lt.fyRL,
    RR: lt.fyRR,
  };
  const coordMap: Record<LabWheelId, readonly [number, number]> = {
    FL: [lf, trackF * 0.5],
    FR: [lf, -trackF * 0.5],
    RL: [-lr, trackR * 0.5],
    RR: [-lr, -trackR * 0.5],
  };

  const wheels = {} as Record<LabWheelId, LabWheelDynamics>;
  for (const id of LAB_WHEEL_IDS) {
    const [wx, wy] = coordMap[id];
    const fz = fzMap[id];
    const fx = fxMap[id];
    const fy = fyMap[id];
    const staticFz = staticMap[id];

    const grip = mu * fz;
    const gripUse = grip > 1e-6 ? Math.hypot(fx, fy) / grip : 0;
    const gripUseClamped = clamp(gripUse, 0, 1);
    const strutRatio =
      staticFz > 1e-6 ? clamp(0.5 + 0.5 * (fz / staticFz - 1), 0, 1) : 0.5;

    let stateLabel: LabWheelStateLabel = '';
    if (fz <= 0) {
      stateLabel = 'no ar';
    } else if (frame.isSlip) {
      stateLabel = 'slip';
    } else if (gripUse >= 0.98) {
      stateLabel = 'limite';
    }

    wheels[id] = {
      id,
      wx,
      wy,
      fx,
      fy,
      fz,
      grip,
      gripUse,
      gripUseClamped,
      strutRatio,
      stateLabel,
    };
  }

  const netFx = lt.fxFL + lt.fxFR + lt.fxRL + lt.fxRR;
  const netFy = lt.fyFL + lt.fyFR + lt.fyRL + lt.fyRR;
  const yawMoment = finiteOr(lt.yawMoment, 0);
  const momentShare =
    scales.momentMax > 1e-6 ? clamp(Math.abs(yawMoment) / scales.momentMax, 0, 1) : 0;

  const accelDenom = Math.max(0.05, finiteOr(limits.accelLimit, 0.45)) * GRAVITY_MS2;
  const brakeDenom = Math.max(0.05, finiteOr(limits.brakeLimit, 0.55)) * GRAVITY_MS2;
  const throttle = clamp(Math.max(0, ax) / accelDenom, 0, 1);
  const brake = clamp(Math.max(0, -ax) / brakeDenom, 0, 1);

  const maxSteerRad =
    specs.maxSteerRad !== undefined &&
    Number.isFinite(specs.maxSteerRad) &&
    specs.maxSteerRad > 0
      ? specs.maxSteerRad
      : DEFAULT_MAX_STEER_RAD;
  const steerRad = finiteOr(frame.steerRad, 0);
  const steerNorm = clamp(steerRad / maxSteerRad, -1, 1);

  return {
    lf,
    lr,
    trackF,
    trackR,
    cgHeight,
    tireRadiusM,
    wheels,
    netFx,
    netFy,
    yawMoment,
    momentShare,
    throttle,
    brake,
    steerRad,
    maxSteerRad,
    steerNorm,
  };
}
