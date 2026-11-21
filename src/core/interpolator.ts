/**
 * Interpolador contínuo 60+ FPS sobre `TelemetryTrackSoA` (Bloco F).
 * - Posição `(x, y)`: spline cúbica de Hermite com tangentes monótonas (Fritsch-Carlson, sem overshoot).
 * - Ângulos (`yaw`, `steerRad`): `interpolateShortestAngle` (caminho curto em 359° -> 1° e -179° -> +179°).
 * - Cursor deslizante O(1) em reprodução sequencial com fallback para busca binária O(log n) em seek.
 * - Suporta `sampleAt(tSec, outFrame?)` com zero alocações por frame.
 *
 * Testes:
 *   npx vitest run test/interpolator.test.ts
 */
import { TRACK_FLAG, type TelemetryTrackSoA } from './soa.ts';

export interface SampleFrame {
  t: number;
  lat: number;
  lon: number;
  x: number;
  y: number;
  speedMs: number;
  ax: number;
  ay: number;
  az: number;
  omegaZ: number;
  yaw: number;
  steerRad: number;
  rollRad: number;
  pitchRad: number;
  fzFL: number;
  fzFR: number;
  fzRL: number;
  fzRR: number;
  kammIndex: number;
  roadGradePct: number;
  distM: number;
  flags?: number;
  gpsValid: boolean;
  isGap: boolean;
  isTunnelDr: boolean;
  isSlip: boolean;
  segmentIndex?: number;
}

export interface TelemetryInterpolator {
  readonly durationSec: number;
  readonly startSec: number;
  readonly endSec: number;
  sampleAt(tSec: number, out?: SampleFrame): SampleFrame;
}

/**
 * Shortest-angle linear interpolation between `a1Rad` and `a2Rad` (Block F):
 * `delta = atan2(sin(a2 - a1), cos(a2 - a1))`, `result = a1 + alpha * delta`.
 */
export function interpolateShortestAngle(
  a1Rad: number,
  a2Rad: number,
  alpha: number,
): number {
  const delta = Math.atan2(Math.sin(a2Rad - a1Rad), Math.cos(a2Rad - a1Rad));
  return a1Rad + alpha * delta;
}

/**
 * Computes Fritsch-Carlson monotone cubic Hermite tangents for a 1D channel,
 * preventing overshoot on braking-to-stop plateaus and sharp corners while
 * breaking tangent continuity across `IS_GAP` segments.
 */
function computeMonotoneTangents(
  t: Float64Array,
  v: Float64Array,
  flags: Uint8Array,
): Float64Array {
  const n = t.length;
  const m = new Float64Array(n);
  if (n < 2) return m;

  const secants = new Float64Array(n - 1);
  const gapAfter = new Uint8Array(n - 1);

  for (let i = 0; i < n - 1; i++) {
    const dt = (t[i + 1] ?? 0) - (t[i] ?? 0);
    const isGap = ((flags[i + 1] ?? 0) & TRACK_FLAG.IS_GAP) !== 0;
    if (isGap || dt <= 0) {
      secants[i] = 0;
      gapAfter[i] = 1;
    } else {
      secants[i] = ((v[i + 1] ?? 0) - (v[i] ?? 0)) / dt;
    }
  }

  m[0] = secants[0] ?? 0;
  m[n - 1] = secants[n - 2] ?? 0;

  for (let i = 1; i < n - 1; i++) {
    const sPrev = secants[i - 1] ?? 0;
    const sNext = secants[i] ?? 0;
    if (gapAfter[i - 1] === 1 || gapAfter[i] === 1 || sPrev * sNext <= 0) {
      m[i] = 0;
    } else {
      m[i] = 0.5 * (sPrev + sNext);
    }
  }

  // Fritsch-Carlson monotonicity clamp: alpha^2 + beta^2 <= 9
  for (let i = 0; i < n - 1; i++) {
    const d = secants[i] ?? 0;
    if (d === 0 || gapAfter[i] === 1) {
      m[i] = 0;
      m[i + 1] = 0;
      continue;
    }
    const alpha = (m[i] ?? 0) / d;
    const beta = (m[i + 1] ?? 0) / d;
    const hypotSq = alpha * alpha + beta * beta;
    if (hypotSq > 9) {
      const tau = 3 / Math.sqrt(hypotSq);
      m[i] = tau * alpha * d;
      m[i + 1] = tau * beta * d;
    }
  }

  return m;
}

function createEmptyFrame(): SampleFrame {
  return {
    t: 0,
    lat: 0,
    lon: 0,
    x: 0,
    y: 0,
    speedMs: 0,
    ax: 0,
    ay: 0,
    az: 0,
    omegaZ: 0,
    yaw: 0,
    steerRad: 0,
    rollRad: 0,
    pitchRad: 0,
    fzFL: 0,
    fzFR: 0,
    fzRL: 0,
    fzRR: 0,
    kammIndex: 0,
    roadGradePct: 0,
    distM: 0,
    flags: 0,
    gpsValid: false,
    isGap: false,
    isTunnelDr: false,
    isSlip: false,
    segmentIndex: 0,
  };
}

function writeExactSample(
  track: TelemetryTrackSoA,
  idx: number,
  target: SampleFrame,
): SampleFrame {
  const flags = track.flags[idx] ?? 0;
  target.t = track.t[idx] ?? 0;
  target.lat = track.lat[idx] ?? 0;
  target.lon = track.lon[idx] ?? 0;
  target.x = track.x[idx] ?? 0;
  target.y = track.y[idx] ?? 0;
  target.speedMs = track.speedMs[idx] ?? 0;
  target.ax = track.ax[idx] ?? 0;
  target.ay = track.ay[idx] ?? 0;
  target.az = track.az[idx] ?? 0;
  target.omegaZ = track.omegaZ[idx] ?? 0;
  target.yaw = track.yaw[idx] ?? 0;
  target.steerRad = track.steerRad[idx] ?? 0;
  target.rollRad = track.rollRad[idx] ?? 0;
  target.pitchRad = track.pitchRad[idx] ?? 0;
  target.fzFL = track.fzFL[idx] ?? 0;
  target.fzFR = track.fzFR[idx] ?? 0;
  target.fzRL = track.fzRL[idx] ?? 0;
  target.fzRR = track.fzRR[idx] ?? 0;
  target.kammIndex = track.kammIndex[idx] ?? 0;
  target.roadGradePct = track.roadGradePct[idx] ?? 0;
  target.distM = track.distM[idx] ?? 0;
  target.flags = flags;
  target.gpsValid = (flags & TRACK_FLAG.GPS_VALID) !== 0;
  target.isGap = (flags & TRACK_FLAG.IS_GAP) !== 0;
  target.isTunnelDr = (flags & TRACK_FLAG.IS_TUNNEL_DR) !== 0;
  target.isSlip = (flags & TRACK_FLAG.IS_SLIP) !== 0;
  target.segmentIndex = idx;
  return target;
}

function evalHermite(
  p0: number,
  p1: number,
  m0: number,
  m1: number,
  h: number,
  s: number,
): number {
  const s2 = s * s;
  const s3 = s2 * s;
  const h00 = 2 * s3 - 3 * s2 + 1;
  const h10 = s3 - 2 * s2 + s;
  const h01 = -2 * s3 + 3 * s2;
  const h11 = s3 - s2;
  return h00 * p0 + h10 * h * m0 + h01 * p1 + h11 * h * m1;
}

function lerp(a: number, b: number, s: number): number {
  return a + (b - a) * s;
}

/**
 * Creates a continuous 60+ FPS interpolator over `track` with O(1) sequential
 * cursor lookup, O(log n) binary-search seek fallback, Fritsch-Carlson cubic
 * Hermite position interpolation, and shortest-angle yaw/steer interpolation.
 */
export function createInterpolator(track: TelemetryTrackSoA): TelemetryInterpolator {
  const n = track.length;
  const startSec = n > 0 ? (track.t[0] ?? 0) : 0;
  const endSec = n > 0 ? (track.t[n - 1] ?? 0) : 0;
  const durationSec = Math.max(0, endSec - startSec);

  const mx = computeMonotoneTangents(track.t, track.x, track.flags);
  const my = computeMonotoneTangents(track.t, track.y, track.flags);

  let cursor = 0;

  function findSegment(tSec: number): number {
    // O(1) fast path: stay in current segment
    if (
      cursor >= 0 &&
      cursor < n - 1 &&
      (track.t[cursor] ?? 0) <= tSec &&
      tSec <= (track.t[cursor + 1] ?? 0)
    ) {
      return cursor;
    }

    // O(1) fast path: advance one segment in sequential playback
    if (
      cursor + 2 < n &&
      (track.t[cursor + 1] ?? 0) <= tSec &&
      tSec <= (track.t[cursor + 2] ?? 0)
    ) {
      cursor += 1;
      return cursor;
    }

    // O(log n) binary search fallback for random seeks
    let lo = 0;
    let hi = n - 2;
    while (lo <= hi) {
      const mid = (lo + hi) >>> 1;
      const tMid = track.t[mid] ?? 0;
      const tNext = track.t[mid + 1] ?? 0;
      if (tSec < tMid) {
        hi = mid - 1;
      } else if (tSec > tNext) {
        lo = mid + 1;
      } else {
        cursor = mid;
        return mid;
      }
    }

    cursor = Math.max(0, Math.min(n - 2, lo));
    return cursor;
  }

  function sampleAt(tSec: number, out?: SampleFrame): SampleFrame {
    const target = out ?? createEmptyFrame();

    if (n === 0) {
      return target;
    }
    if (n === 1 || !Number.isFinite(tSec) || tSec <= startSec) {
      cursor = 0;
      return writeExactSample(track, 0, target);
    }
    if (tSec >= endSec) {
      cursor = Math.max(0, n - 2);
      return writeExactSample(track, n - 1, target);
    }

    const i = findSegment(tSec);
    const j = i + 1;
    const t0 = track.t[i] ?? 0;
    const t1 = track.t[j] ?? 0;
    const h = t1 - t0;

    if (h <= 0) {
      return writeExactSample(track, i, target);
    }

    const flags1 = track.flags[j] ?? 0;
    const gapAcross = (flags1 & TRACK_FLAG.IS_GAP) !== 0;

    // Never curve-interpolate across a temporal gap (> 1.0 s): step to nearest endpoint
    if (gapAcross) {
      return writeExactSample(track, tSec - t0 < h * 0.5 ? i : j, target);
    }

    const s = (tSec - t0) / h;

    target.t = tSec;
    target.x = evalHermite(
      track.x[i] ?? 0,
      track.x[j] ?? 0,
      mx[i] ?? 0,
      mx[j] ?? 0,
      h,
      s,
    );
    target.y = evalHermite(
      track.y[i] ?? 0,
      track.y[j] ?? 0,
      my[i] ?? 0,
      my[j] ?? 0,
      h,
      s,
    );
    target.lat = lerp(track.lat[i] ?? 0, track.lat[j] ?? 0, s);
    target.lon = lerp(track.lon[i] ?? 0, track.lon[j] ?? 0, s);

    target.speedMs = lerp(track.speedMs[i] ?? 0, track.speedMs[j] ?? 0, s);
    target.ax = lerp(track.ax[i] ?? 0, track.ax[j] ?? 0, s);
    target.ay = lerp(track.ay[i] ?? 0, track.ay[j] ?? 0, s);
    target.az = lerp(track.az[i] ?? 0, track.az[j] ?? 0, s);
    target.omegaZ = lerp(track.omegaZ[i] ?? 0, track.omegaZ[j] ?? 0, s);

    target.yaw = interpolateShortestAngle(track.yaw[i] ?? 0, track.yaw[j] ?? 0, s);
    target.steerRad = interpolateShortestAngle(
      track.steerRad[i] ?? 0,
      track.steerRad[j] ?? 0,
      s,
    );
    target.rollRad = lerp(track.rollRad[i] ?? 0, track.rollRad[j] ?? 0, s);
    target.pitchRad = lerp(track.pitchRad[i] ?? 0, track.pitchRad[j] ?? 0, s);

    target.fzFL = lerp(track.fzFL[i] ?? 0, track.fzFL[j] ?? 0, s);
    target.fzFR = lerp(track.fzFR[i] ?? 0, track.fzFR[j] ?? 0, s);
    target.fzRL = lerp(track.fzRL[i] ?? 0, track.fzRL[j] ?? 0, s);
    target.fzRR = lerp(track.fzRR[i] ?? 0, track.fzRR[j] ?? 0, s);
    target.kammIndex = lerp(track.kammIndex[i] ?? 0, track.kammIndex[j] ?? 0, s);
    target.roadGradePct = lerp(track.roadGradePct[i] ?? 0, track.roadGradePct[j] ?? 0, s);
    target.distM = lerp(track.distM[i] ?? 0, track.distM[j] ?? 0, s);

    const flags0 = track.flags[i] ?? 0;
    const activeFlags = s < 0.5 ? flags0 : flags1;
    target.flags = activeFlags;
    target.gpsValid = (activeFlags & TRACK_FLAG.GPS_VALID) !== 0;
    target.isGap = false;
    target.isTunnelDr = (activeFlags & TRACK_FLAG.IS_TUNNEL_DR) !== 0;
    target.isSlip = (activeFlags & TRACK_FLAG.IS_SLIP) !== 0;
    target.segmentIndex = i;

    return target;
  }

  return {
    durationSec,
    startSec,
    endSec,
    sampleAt,
  };
}
