/**
 * Empacotamento Structure-of-Arrays (SoA) em TypedArrays contíguos (`TelemetryTrackSoA`)
 * para transferência zero-copy entre Web Worker e main thread via `postMessage(msg, transferables)`.
 *
 * Testes:
 *   npx vitest run test/soa.test.ts
 */

export const TRACK_FLAG = {
  GPS_VALID: 1,
  IS_GAP: 2,
  IS_TUNNEL_DR: 4,
  IS_SLIP: 8,
} as const;

export interface ProcessedFrameInput {
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
  gpsValid: boolean;
  isGap: boolean;
  isTunnelDr: boolean;
  isSlip: boolean;
}

export interface TelemetryTrackSoA {
  length: number;
  t: Float64Array;
  lat: Float64Array;
  lon: Float64Array;
  x: Float64Array;
  y: Float64Array;
  speedMs: Float32Array;
  ax: Float32Array;
  ay: Float32Array;
  az: Float32Array;
  omegaZ: Float32Array;
  yaw: Float32Array;
  steerRad: Float32Array;
  rollRad: Float32Array;
  pitchRad: Float32Array;
  fzFL: Float32Array;
  fzFR: Float32Array;
  fzRL: Float32Array;
  fzRR: Float32Array;
  kammIndex: Float32Array;
  roadGradePct: Float32Array;
  distM: Float32Array;
  flags: Uint8Array;
}

/**
 * Packs an array of processed telemetry frames into contiguous TypedArrays
 * (`Float64Array` for time/coordinates, `Float32Array` for dynamics, `Uint8Array` for bitmask flags).
 */
export function packToSoA(frames: readonly ProcessedFrameInput[]): TelemetryTrackSoA {
  const n = frames.length;

  const t = new Float64Array(n);
  const lat = new Float64Array(n);
  const lon = new Float64Array(n);
  const x = new Float64Array(n);
  const y = new Float64Array(n);

  const speedMs = new Float32Array(n);
  const ax = new Float32Array(n);
  const ay = new Float32Array(n);
  const az = new Float32Array(n);
  const omegaZ = new Float32Array(n);
  const yaw = new Float32Array(n);
  const steerRad = new Float32Array(n);
  const rollRad = new Float32Array(n);
  const pitchRad = new Float32Array(n);
  const fzFL = new Float32Array(n);
  const fzFR = new Float32Array(n);
  const fzRL = new Float32Array(n);
  const fzRR = new Float32Array(n);
  const kammIndex = new Float32Array(n);
  const roadGradePct = new Float32Array(n);
  const distM = new Float32Array(n);

  const flags = new Uint8Array(n);

  for (let i = 0; i < n; i++) {
    const f = frames[i];
    if (!f) continue;

    t[i] = f.t;
    lat[i] = f.lat;
    lon[i] = f.lon;
    x[i] = f.x;
    y[i] = f.y;

    speedMs[i] = f.speedMs;
    ax[i] = f.ax;
    ay[i] = f.ay;
    az[i] = f.az;
    omegaZ[i] = f.omegaZ;
    yaw[i] = f.yaw;
    steerRad[i] = f.steerRad;
    rollRad[i] = f.rollRad;
    pitchRad[i] = f.pitchRad;
    fzFL[i] = f.fzFL;
    fzFR[i] = f.fzFR;
    fzRL[i] = f.fzRL;
    fzRR[i] = f.fzRR;
    kammIndex[i] = f.kammIndex;
    roadGradePct[i] = f.roadGradePct;
    distM[i] = f.distM;

    let mask = 0;
    if (f.gpsValid) mask |= TRACK_FLAG.GPS_VALID;
    if (f.isGap) mask |= TRACK_FLAG.IS_GAP;
    if (f.isTunnelDr) mask |= TRACK_FLAG.IS_TUNNEL_DR;
    if (f.isSlip) mask |= TRACK_FLAG.IS_SLIP;
    flags[i] = mask;
  }

  return {
    length: n,
    t,
    lat,
    lon,
    x,
    y,
    speedMs,
    ax,
    ay,
    az,
    omegaZ,
    yaw,
    steerRad,
    rollRad,
    pitchRad,
    fzFL,
    fzFR,
    fzRL,
    fzRR,
    kammIndex,
    roadGradePct,
    distM,
    flags,
  };
}

/**
 * Collects all unique backing `ArrayBuffer` instances from a `TelemetryTrackSoA`
 * for zero-copy transfer via `postMessage(msg, transferables)`.
 */
export function getTransferables(track: TelemetryTrackSoA): ArrayBuffer[] {
  const buffers = new Set<ArrayBuffer>([
    track.t.buffer as ArrayBuffer,
    track.lat.buffer as ArrayBuffer,
    track.lon.buffer as ArrayBuffer,
    track.x.buffer as ArrayBuffer,
    track.y.buffer as ArrayBuffer,
    track.speedMs.buffer as ArrayBuffer,
    track.ax.buffer as ArrayBuffer,
    track.ay.buffer as ArrayBuffer,
    track.az.buffer as ArrayBuffer,
    track.omegaZ.buffer as ArrayBuffer,
    track.yaw.buffer as ArrayBuffer,
    track.steerRad.buffer as ArrayBuffer,
    track.rollRad.buffer as ArrayBuffer,
    track.pitchRad.buffer as ArrayBuffer,
    track.fzFL.buffer as ArrayBuffer,
    track.fzFR.buffer as ArrayBuffer,
    track.fzRL.buffer as ArrayBuffer,
    track.fzRR.buffer as ArrayBuffer,
    track.kammIndex.buffer as ArrayBuffer,
    track.roadGradePct.buffer as ArrayBuffer,
    track.distM.buffer as ArrayBuffer,
    track.flags.buffer as ArrayBuffer,
  ]);
  return Array.from(buffers);
}
