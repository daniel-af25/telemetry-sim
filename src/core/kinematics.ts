/**
 * Cinemática ENU (projeção elipsoidal WGS84 <-> ENU), filtro complementar de yaw
 * (ISO 8855 anti-horário a partir de +Este) e dead-reckoning em túneis com loop-closure C0.
 *
 * Testes:
 *   npx vitest run test/kinematics.test.ts
 */
import type { CalibratedSampleIso } from './types.ts';

const WGS84_A = 6378137.0;
const WGS84_E2 = 0.00669437999;
const DEG_TO_RAD = Math.PI / 180;
const RAD_TO_DEG = 180 / Math.PI;

const ALPHA_GPS = 0.15;
const MIN_GPS_YAW_SPEED_MS = 2.0;
const MIN_GPS_YAW_DISP_M = 0.2;

export interface Wgs84Coord {
  lat: number;
  lon: number;
}

export interface EnuCoord {
  x: number;
  y: number;
}

export interface KinematicPoint {
  sampleIndex: number;
  elapsedSec: number;
  dtSec: number;
  isGap: boolean;
  x: number;
  y: number;
  lat: number;
  lon: number;
  yawRad: number;
  speedMs: number;
  distM: number;
  isTunnelDr: boolean;
  gpsValid: boolean;
}

export interface KinematicsResult {
  origin: Wgs84Coord;
  points: KinematicPoint[];
}

function wgs84CurvatureRadii(originLatDeg: number): { rm: number; rn: number; cosPhi: number } {
  const phi0 = originLatDeg * DEG_TO_RAD;
  const sinPhi = Math.sin(phi0);
  const cosPhi = Math.cos(phi0);
  const denom = 1 - WGS84_E2 * sinPhi * sinPhi;
  const rn = WGS84_A / Math.sqrt(denom);
  const rm = (WGS84_A * (1 - WGS84_E2)) / Math.pow(denom, 1.5);
  return { rm, rn, cosPhi };
}

/**
 * Projects WGS84 `(lat, lon)` degrees into local tangent ENU meters
 * (`+x = East`, `+y = North`) around `origin` using WGS84 radii `R_M` and `R_N`.
 */
export function wgs84ToEnu(lat: number, lon: number, origin: Wgs84Coord): EnuCoord {
  const { rm, rn, cosPhi } = wgs84CurvatureRadii(origin.lat);
  const dLatRad = (lat - origin.lat) * DEG_TO_RAD;
  const dLonRad = (lon - origin.lon) * DEG_TO_RAD;
  return {
    x: dLonRad * rn * cosPhi,
    y: dLatRad * rm,
  };
}

/**
 * Inverse projection from local tangent ENU meters (`+x = East`, `+y = North`)
 * back to WGS84 `(lat, lon)` degrees around `origin`.
 */
export function enuToWgs84(x: number, y: number, origin: Wgs84Coord): Wgs84Coord {
  const { rm, rn, cosPhi } = wgs84CurvatureRadii(origin.lat);
  const dLatRad = y / rm;
  const dLonRad = Math.abs(cosPhi) > 1e-12 ? x / (rn * cosPhi) : 0;
  return {
    lat: origin.lat + dLatRad * RAD_TO_DEG,
    lon: origin.lon + dLonRad * RAD_TO_DEG,
  };
}

function normalizeAngle(rad: number): number {
  return Math.atan2(Math.sin(rad), Math.cos(rad));
}

function shortestAngleDelta(fromRad: number, toRad: number): number {
  return Math.atan2(Math.sin(toRad - fromRad), Math.cos(toRad - fromRad));
}

/**
 * Reconstructs continuous local ENU trajectory, complementary-filtered ISO 8855 yaw
 * (CCW from +East), cumulative distance, and C0 loop-closed tunnel dead-reckoning.
 */
export function reconstructKinematics(
  samples: readonly CalibratedSampleIso[],
): KinematicsResult {
  const firstValid = samples.find(
    (s) => s.gpsValid && s.lat !== null && s.lon !== null,
  );
  const origin: Wgs84Coord =
    firstValid && firstValid.lat !== null && firstValid.lon !== null
      ? { lat: firstValid.lat, lon: firstValid.lon }
      : { lat: 0, lon: 0 };

  if (samples.length === 0) {
    return { origin, points: [] };
  }

  const points: KinematicPoint[] = [];
  let prevX = 0;
  let prevY = 0;
  let prevYaw = 0;
  let yawInitialized = false;
  let cumDistM = 0;
  let tunnelStartIdx: number | null = null;
  let hasInitialPosition = false;

  for (let i = 0; i < samples.length; i++) {
    const s = samples[i];
    if (!s) continue;

    const dt = s.dtSec > 0 ? s.dtSec : 0.2;
    const hasGpsFix = s.gpsValid && s.lat !== null && s.lon !== null;

    // Temporal gap (> 1.0 s): skip derivatives/integration and re-anchor on next valid fix
    if (s.isGap && i > 0) {
      tunnelStartIdx = null;
      yawInitialized = false;

      if (hasGpsFix && s.lat !== null && s.lon !== null) {
        const enu = wgs84ToEnu(s.lat, s.lon, origin);
        prevX = enu.x;
        prevY = enu.y;
        hasInitialPosition = true;
        points.push({
          sampleIndex: s.sampleIndex ?? i,
          elapsedSec: s.elapsedSec,
          dtSec: dt,
          isGap: true,
          x: enu.x,
          y: enu.y,
          lat: s.lat,
          lon: s.lon,
          yawRad: prevYaw,
          speedMs: s.speedMs,
          distM: cumDistM,
          isTunnelDr: false,
          gpsValid: true,
        });
      } else {
        const wgs = enuToWgs84(prevX, prevY, origin);
        points.push({
          sampleIndex: s.sampleIndex ?? i,
          elapsedSec: s.elapsedSec,
          dtSec: dt,
          isGap: true,
          x: prevX,
          y: prevY,
          lat: wgs.lat,
          lon: wgs.lon,
          yawRad: prevYaw,
          speedMs: s.speedMs,
          distM: cumDistM,
          isTunnelDr: true,
          gpsValid: false,
        });
      }
      continue;
    }

    if (!hasGpsFix) {
      // Dead-reckoning inside tunnel (alpha_gps = 0)
      if (tunnelStartIdx === null) {
        tunnelStartIdx = i;
      }

      const yaw = i === 0 ? prevYaw : normalizeAngle(prevYaw + s.omegaZ * dt);
      const x = i === 0 ? prevX : prevX + s.speedMs * Math.cos(yaw) * dt;
      const y = i === 0 ? prevY : prevY + s.speedMs * Math.sin(yaw) * dt;
      const stepDist = i === 0 ? 0 : Math.hypot(x - prevX, y - prevY);
      cumDistM += stepDist;

      const wgs = enuToWgs84(x, y, origin);
      points.push({
        sampleIndex: s.sampleIndex ?? i,
        elapsedSec: s.elapsedSec,
        dtSec: dt,
        isGap: false,
        x,
        y,
        lat: wgs.lat,
        lon: wgs.lon,
        yawRad: yaw,
        speedMs: s.speedMs,
        distM: cumDistM,
        isTunnelDr: true,
        gpsValid: false,
      });

      prevX = x;
      prevY = y;
      prevYaw = yaw;
      continue;
    }

    // Valid GPS fix
    const enu = wgs84ToEnu(s.lat!, s.lon!, origin);
    const yawPred = i === 0 ? prevYaw : normalizeAngle(prevYaw + s.omegaZ * dt);

    // Loop-closure upon exiting a tunnel: distribute residual (errX, errY) linearly
    if (tunnelStartIdx !== null && i > tunnelStartIdx) {
      const predExitX = prevX + s.speedMs * Math.cos(yawPred) * dt;
      const predExitY = prevY + s.speedMs * Math.sin(yawPred) * dt;
      const errX = enu.x - predExitX;
      const errY = enu.y - predExitY;
      const tunnelLen = i - tunnelStartIdx;

      for (let k = tunnelStartIdx; k < i; k++) {
        const pt = points[k];
        if (!pt) continue;
        const frac = (k - tunnelStartIdx + 1) / (tunnelLen + 1);
        pt.x += errX * frac;
        pt.y += errY * frac;
        const closedWgs = enuToWgs84(pt.x, pt.y, origin);
        pt.lat = closedWgs.lat;
        pt.lon = closedWgs.lon;
      }

      // Recompute cumulative distance across the closed tunnel segment
      const baseDist = tunnelStartIdx > 0 ? (points[tunnelStartIdx - 1]?.distM ?? 0) : 0;
      let runningDist = baseDist;
      for (let k = tunnelStartIdx; k < i; k++) {
        const pt = points[k];
        const prevPt = k > 0 ? points[k - 1] : undefined;
        if (!pt) continue;
        if (prevPt) {
          runningDist += Math.hypot(pt.x - prevPt.x, pt.y - prevPt.y);
        }
        pt.distM = runningDist;
      }

      const lastTunnelPt = points[i - 1];
      if (lastTunnelPt) {
        prevX = lastTunnelPt.x;
        prevY = lastTunnelPt.y;
        cumDistM = lastTunnelPt.distM;
      }
      tunnelStartIdx = null;
    }

    const dx = hasInitialPosition ? enu.x - prevX : 0;
    const dy = hasInitialPosition ? enu.y - prevY : 0;
    const stepDist = hasInitialPosition ? Math.hypot(dx, dy) : 0;
    cumDistM += stepDist;

    let yaw = yawPred;
    if (hasInitialPosition && s.speedMs > MIN_GPS_YAW_SPEED_MS && stepDist > MIN_GPS_YAW_DISP_M) {
      const gpsYaw = Math.atan2(dy, dx);
      if (!yawInitialized) {
        yaw = gpsYaw;
        yawInitialized = true;
        // Backfill initial pre-motion samples with the first valid heading
        for (let k = i - 1; k >= 0; k--) {
          const prevPt = points[k];
          if (!prevPt || prevPt.isGap) break;
          prevPt.yawRad = gpsYaw;
        }
      } else {
        yaw = normalizeAngle(yawPred + ALPHA_GPS * shortestAngleDelta(yawPred, gpsYaw));
      }
    }

    points.push({
      sampleIndex: s.sampleIndex ?? i,
      elapsedSec: s.elapsedSec,
      dtSec: dt,
      isGap: false,
      x: enu.x,
      y: enu.y,
      lat: s.lat!,
      lon: s.lon!,
      yawRad: yaw,
      speedMs: s.speedMs,
      distM: cumDistM,
      isTunnelDr: false,
      gpsValid: true,
    });

    prevX = enu.x;
    prevY = enu.y;
    prevYaw = yaw;
    hasInitialPosition = true;
  }

  return { origin, points };
}
