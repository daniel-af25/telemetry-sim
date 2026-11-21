/**
 * Exportador científico de recortes (10–20 s) em formato `# schema=6` (`src/core/schema6Export.ts`),
 * 100% compatível com `tools/view3d.py` e `tools/topdown.py` do simulador `rallysim-master`.
 *
 * - Linha 1: metadados `# schema=6 dt=... model=2 lf=... lr=... track_front=... track_rear=... cg_height=... wheel_radius=... max_steer=... springs=1 mu=...`
 * - Linha 2: 40 colunas exatas em unidades SI estritas (ISO 8855).
 * - Origem transladada para `time = 0.0`, `pos.x = 0.0`, `pos.y = 0.0` no início do recorte.
 * - 100% puro (sem DOM, sem dependências externas).
 *
 * Testes:
 *   npx vitest run test/unit/schema6Export.test.ts
 */
import type { TelemetryTrackSoA } from './soa.ts';
import type { KammLimits } from './types.ts';
import type { ResolvedVehicleSpecs } from './vehicleSpecs.ts';

const GRAVITY_MS2 = 9.80665;
const DEFAULT_DT_SEC = 0.2;
const DEFAULT_CLIP_SPAN_SEC = 16.0;
const MIN_CLIP_SPAN_SEC = 10.0;
const MAX_CLIP_SPAN_SEC = 20.0;
const WINDOW_EPSILON_SEC = 1e-9;

export const SCHEMA6_COLUMNS = [
  'time',
  'pos.x',
  'pos.y',
  'pos.z',
  'yaw',
  'roll',
  'pitch',
  'speed',
  'u',
  'v',
  'steer',
  'throttle',
  'brake',
  'handbrake',
  'a_lat',
  'yaw_moment',
  'wheel.FL.Fx',
  'wheel.FL.Fy',
  'wheel.FL.Fz',
  'wheel.FL.omega',
  'wheel.FL.slipRatio',
  'wheel.FL.grip',
  'wheel.FR.Fx',
  'wheel.FR.Fy',
  'wheel.FR.Fz',
  'wheel.FR.omega',
  'wheel.FR.slipRatio',
  'wheel.FR.grip',
  'wheel.RL.Fx',
  'wheel.RL.Fy',
  'wheel.RL.Fz',
  'wheel.RL.omega',
  'wheel.RL.slipRatio',
  'wheel.RL.grip',
  'wheel.RR.Fx',
  'wheel.RR.Fy',
  'wheel.RR.Fz',
  'wheel.RR.omega',
  'wheel.RR.slipRatio',
  'wheel.RR.grip',
] as const;

export interface Schema6ExportWindow {
  startSec: number;
  endSec: number;
}

export interface Schema6SourceFrame {
  t: number;
  x: number;
  y: number;
  posZ?: number;
  yaw: number;
  speedMs: number;
  u?: number;
  v?: number;
  ax: number;
  ay: number;
  steerRad: number;
  rollRad: number;
  pitchRad: number;
  fzFL: number;
  fzFR: number;
  fzRL: number;
  fzRR: number;
  fxFL?: number;
  fxFR?: number;
  fxRL?: number;
  fxRR?: number;
  fyFL?: number;
  fyFR?: number;
  fyRL?: number;
  fyRR?: number;
  slipRatioFL?: number;
  slipRatioFR?: number;
  slipRatioRL?: number;
  slipRatioRR?: number;
  yawMoment?: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function finiteOr(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) ? value : fallback;
}

function fmt(value: number, decimals: number = 6): string {
  const safe = Number.isFinite(value) ? value : 0;
  const fixed = safe.toFixed(decimals);
  // Normalize "-0.000000" to "0.000000"
  return Number(fixed) === 0 ? (0).toFixed(decimals) : fixed;
}

function computeMedianDt(frames: readonly Schema6SourceFrame[]): number {
  const dts: number[] = [];
  for (let i = 1; i < frames.length; i++) {
    const prev = frames[i - 1];
    const cur = frames[i];
    if (!prev || !cur) continue;
    const dt = cur.t - prev.t;
    if (Number.isFinite(dt) && dt > 1e-6 && dt <= 1.0) {
      dts.push(dt);
    }
  }
  if (dts.length === 0) return DEFAULT_DT_SEC;
  dts.sort((a, b) => a - b);
  const mid = dts.length >>> 1;
  if (dts.length % 2 === 1) {
    return dts[mid] ?? DEFAULT_DT_SEC;
  }
  return 0.5 * ((dts[mid - 1] ?? DEFAULT_DT_SEC) + (dts[mid] ?? DEFAULT_DT_SEC));
}

/**
 * Computes a 10–20 s export window centered around `centerSec`, clamped cleanly to `[0, durationSec]`.
 */
export function computeSchema6ClipWindow(
  centerSec: number,
  durationSec: number,
  spanSec: number = DEFAULT_CLIP_SPAN_SEC,
): Schema6ExportWindow {
  const safeDuration = Math.max(0, Number.isFinite(durationSec) ? durationSec : 0);
  const clampedSpan = clamp(
    Number.isFinite(spanSec) ? spanSec : DEFAULT_CLIP_SPAN_SEC,
    MIN_CLIP_SPAN_SEC,
    MAX_CLIP_SPAN_SEC,
  );
  if (safeDuration <= clampedSpan) {
    return { startSec: 0, endSec: safeDuration };
  }

  const safeCenter = clamp(Number.isFinite(centerSec) ? centerSec : 0, 0, safeDuration);
  const half = clampedSpan * 0.5;
  let startSec = safeCenter - half;
  let endSec = safeCenter + half;

  if (startSec < 0) {
    endSec = Math.min(safeDuration, endSec - startSec);
    startSec = 0;
  } else if (endSec > safeDuration) {
    startSec = Math.max(0, startSec - (endSec - safeDuration));
    endSec = safeDuration;
  }

  return { startSec, endSec };
}

/**
 * Extracts `Schema6SourceFrame[]` directly from a packed `TelemetryTrackSoA` for export.
 */
export function extractSchema6FramesFromSoA(
  track: TelemetryTrackSoA,
  window?: Schema6ExportWindow,
): Schema6SourceFrame[] {
  const out: Schema6SourceFrame[] = [];
  const startSec = window ? window.startSec - WINDOW_EPSILON_SEC : -Infinity;
  const endSec = window ? window.endSec + WINDOW_EPSILON_SEC : Infinity;

  for (let i = 0; i < track.length; i++) {
    const t = track.t[i] ?? 0;
    if (t < startSec || t > endSec) continue;
    out.push({
      t,
      x: track.x[i] ?? 0,
      y: track.y[i] ?? 0,
      yaw: track.yaw[i] ?? 0,
      speedMs: track.speedMs[i] ?? 0,
      ax: track.ax[i] ?? 0,
      ay: track.ay[i] ?? 0,
      steerRad: track.steerRad[i] ?? 0,
      rollRad: track.rollRad[i] ?? 0,
      pitchRad: track.pitchRad[i] ?? 0,
      fzFL: track.fzFL[i] ?? 0,
      fzFR: track.fzFR[i] ?? 0,
      fzRL: track.fzRL[i] ?? 0,
      fzRR: track.fzRR[i] ?? 0,
    });
  }
  return out;
}

/**
 * Exports a scientific `# schema=6` CSV clip (40 exact SI / ISO 8855 columns)
 * 100% compatible with `rallysim-master`'s `tools/view3d.py` and `tools/topdown.py`.
 *
 * - Line 1: `# schema=6 dt=... model=2 lf=... lr=... track_front=... track_rear=... cg_height=... wheel_radius=... max_steer=... springs=1 mu=...`
 * - Line 2: 40 exact headers (`SCHEMA6_COLUMNS`)
 * - Rows: origin translated to `(time = 0.0, pos.x = 0.0, pos.y = 0.0)` at the start of the clip.
 */
export function exportSchema6Csv(
  frames: readonly Schema6SourceFrame[],
  specs: ResolvedVehicleSpecs,
  limits: KammLimits,
  window?: Schema6ExportWindow,
): string {
  const sliced = window
    ? frames.filter(
        (f) =>
          f.t >= window.startSec - WINDOW_EPSILON_SEC &&
          f.t <= window.endSec + WINDOW_EPSILON_SEC,
      )
    : [...frames];

  const L = Math.max(1.5, finiteOr(specs.wheelbaseL, 2.65));
  const frontWeightRatio = clamp(finiteOr(specs.frontWeightRatio, 0.58), 0.2, 0.8);
  const lr = L * frontWeightRatio;
  const lf = L - lr;
  const trackF = Math.max(1.0, finiteOr(specs.trackF, 1.55));
  const trackR = Math.max(1.0, finiteOr(specs.trackR, 1.55));
  const cgHeight = Math.max(0.2, finiteOr(specs.cgHeight, 0.54));
  const tireRadiusM = Math.max(0.15, finiteOr(specs.tireRadiusM, 0.316));
  const maxSteerRad = Math.max(0.1, finiteOr(specs.maxSteerRad, 0.6109));
  const mu = clamp(finiteOr(specs.surfaceGrip, limits.gripLimitG || 0.95), 0.1, 2.0);
  const grossMassKg = Math.max(200, finiteOr(specs.grossMassKg, 1500));

  const dtSec = computeMedianDt(sliced);

  const metaLine = [
    '# schema=6',
    `dt=${fmt(dtSec, 2)}`,
    'model=2',
    `lf=${fmt(lf, 4)}`,
    `lr=${fmt(lr, 4)}`,
    `track_front=${fmt(trackF, 4)}`,
    `track_rear=${fmt(trackR, 4)}`,
    `cg_height=${fmt(cgHeight, 4)}`,
    `wheel_radius=${fmt(tireRadiusM, 4)}`,
    `max_steer=${fmt(maxSteerRad, 4)}`,
    'springs=1',
    `mu=${fmt(mu, 3)}`,
  ].join(' ');

  const headerLine = SCHEMA6_COLUMNS.join(',');
  const lines: string[] = [metaLine, headerLine];

  const first = sliced[0];
  if (!first) {
    return `${lines.join('\n')}\n`;
  }

  const t0 = finiteOr(first.t, 0);
  const x0 = finiteOr(first.x, 0);
  const y0 = finiteOr(first.y, 0);

  const accelDenom = Math.max(0.05, finiteOr(limits.accelLimit, 0.45)) * GRAVITY_MS2;
  const brakeDenom = Math.max(0.05, finiteOr(limits.brakeLimit, 0.55)) * GRAVITY_MS2;
  const halfTrackF = trackF * 0.5;
  const halfTrackR = trackR * 0.5;

  for (let i = 0; i < sliced.length; i++) {
    const f = sliced[i];
    if (!f) continue;

    const relTime = Math.max(0, finiteOr(f.t, t0) - t0);
    const posX = finiteOr(f.x, x0) - x0;
    const posY = finiteOr(f.y, y0) - y0;
    const posZ = finiteOr(f.posZ, cgHeight);

    const yaw = finiteOr(f.yaw, 0);
    const roll = finiteOr(f.rollRad, 0);
    const pitch = finiteOr(f.pitchRad, 0);
    const speed = Math.max(0, finiteOr(f.speedMs, 0));
    const u = finiteOr(f.u, speed);
    const v = finiteOr(f.v, 0);
    const steer = finiteOr(f.steerRad, 0);

    const ax = finiteOr(f.ax, 0);
    const ay = finiteOr(f.ay, 0);

    const throttle = clamp(Math.max(0, ax) / accelDenom, 0, 1);
    const brake = clamp(Math.max(0, -ax) / brakeDenom, 0, 1);
    const handbrake = 0;

    // 4-wheel normal loads Fz (N)
    const fzFL = Math.max(0, finiteOr(f.fzFL, 0));
    const fzFR = Math.max(0, finiteOr(f.fzFR, 0));
    const fzRL = Math.max(0, finiteOr(f.fzRL, 0));
    const fzRR = Math.max(0, finiteOr(f.fzRR, 0));
    const totalFz = fzFL + fzFR + fzRL + fzRR;
    const invTotalFz = totalFz > 1e-6 ? 1 / totalFz : 0;

    const totalFx = grossMassKg * ax;
    const totalFy = grossMassKg * ay;

    // Per-wheel horizontal tire forces (use explicit values when supplied, else proportional to Fz)
    const fxFL = finiteOr(f.fxFL, totalFx * fzFL * invTotalFz);
    const fxFR = finiteOr(f.fxFR, totalFx * fzFR * invTotalFz);
    const fxRL = finiteOr(f.fxRL, totalFx * fzRL * invTotalFz);
    const fxRR = finiteOr(f.fxRR, totalFx * fzRR * invTotalFz);

    const fyFL = finiteOr(f.fyFL, totalFy * fzFL * invTotalFz);
    const fyFR = finiteOr(f.fyFR, totalFy * fzFR * invTotalFz);
    const fyRL = finiteOr(f.fyRL, totalFy * fzRL * invTotalFz);
    const fyRR = finiteOr(f.fyRR, totalFy * fzRR * invTotalFz);

    // Yaw moment coherent with rallysim-master tools/view3d.py line 137:
    // sum_w [ wx * (fx * sin(delta) + fy * cos(delta)) - wy * (fx * cos(delta) - fy * sin(delta)) ]
    let yawMoment: number;
    if (f.yawMoment !== undefined && Number.isFinite(f.yawMoment)) {
      yawMoment = f.yawMoment;
    } else {
      const sinD = Math.sin(steer);
      const cosD = Math.cos(steer);
      const mFL =
        lf * (fxFL * sinD + fyFL * cosD) - halfTrackF * (fxFL * cosD - fyFL * sinD);
      const mFR =
        lf * (fxFR * sinD + fyFR * cosD) - -halfTrackF * (fxFR * cosD - fyFR * sinD);
      const mRL = -lr * fyRL - halfTrackR * fxRL;
      const mRR = -lr * fyRR - -halfTrackR * fxRR;
      yawMoment = mFL + mFR + mRL + mRR;
    }

    const wheelOmega = speed / tireRadiusM;
    const slipFL = finiteOr(f.slipRatioFL, 0);
    const slipFR = finiteOr(f.slipRatioFR, 0);
    const slipRL = finiteOr(f.slipRatioRL, 0);
    const slipRR = finiteOr(f.slipRatioRR, 0);

    const gripFL = mu * fzFL;
    const gripFR = mu * fzFR;
    const gripRL = mu * fzRL;
    const gripRR = mu * fzRR;

    lines.push(
      [
        fmt(relTime, 4),
        fmt(posX, 5),
        fmt(posY, 5),
        fmt(posZ, 5),
        fmt(yaw, 6),
        fmt(roll, 6),
        fmt(pitch, 6),
        fmt(speed, 4),
        fmt(u, 4),
        fmt(v, 4),
        fmt(steer, 6),
        fmt(throttle, 4),
        fmt(brake, 4),
        fmt(handbrake, 1),
        fmt(ay, 5),
        fmt(yawMoment, 3),
        // FL
        fmt(fxFL, 3),
        fmt(fyFL, 3),
        fmt(fzFL, 3),
        fmt(wheelOmega, 4),
        fmt(slipFL, 4),
        fmt(gripFL, 3),
        // FR
        fmt(fxFR, 3),
        fmt(fyFR, 3),
        fmt(fzFR, 3),
        fmt(wheelOmega, 4),
        fmt(slipFR, 4),
        fmt(gripFR, 3),
        // RL
        fmt(fxRL, 3),
        fmt(fyRL, 3),
        fmt(fzRL, 3),
        fmt(wheelOmega, 4),
        fmt(slipRL, 4),
        fmt(gripRL, 3),
        // RR
        fmt(fxRR, 3),
        fmt(fyRR, 3),
        fmt(fzRR, 3),
        fmt(wheelOmega, 4),
        fmt(slipRR, 4),
        fmt(gripRR, 3),
      ].join(','),
    );
  }

  return `${lines.join('\n')}\n`;
}
