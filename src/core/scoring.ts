import type { IncidentCategory } from './types.ts';

export const DEBOUNCE_WINDOW_S = 1.0;
export const MIN_MOVING_DATA_S = 300;

const MIN_SLIP_SPEED_MS = 2.0;
const MIN_SLIP_AY_MS2 = 1.5;
const MIN_SLIP_OMEGA_RAD_S = 0.05;
const SLIP_YAW_DIFF_THRESHOLD_MS2 = 3.5;

export interface IncidentCandidate {
  category: IncidentCategory;
  points: number;
  excessRatio: number;
  timestamp?: number;
}

/**
 * Detects vehicle slip while preserving ISO 8855 sign conventions
 * (+ay left turn, +omegaZ CCW). Counter-steering or large divergence
 * between measured lateral acceleration and `speed * omegaZ` triggers slip.
 */
export function evaluateIncidentSlip(
  ay: number,
  speed: number,
  omegaZ: number,
): boolean {
  if (speed < MIN_SLIP_SPEED_MS) {
    return false;
  }

  const absAy = Math.abs(ay);
  const absOmega = Math.abs(omegaZ);
  if (absAy < MIN_SLIP_AY_MS2 || absOmega < MIN_SLIP_OMEGA_RAD_S) {
    return false;
  }

  // Opposite signs between lateral acceleration and yaw rate indicate counter-steer / slip
  if (ay * omegaZ < 0) {
    return true;
  }

  const ayFromYaw = speed * omegaZ;
  return Math.abs(ay - ayFromYaw) > SLIP_YAW_DIFF_THRESHOLD_MS2;
}

/**
 * Selects the worst incident from a debounce cluster, prioritizing `points`
 * and breaking ties by `excessRatio`.
 */
export function selectDebouncedIncident<T extends IncidentCandidate>(events: T[]): T {
  const first = events[0];
  if (!first) {
    throw new Error('Cannot select debounced incident from an empty list');
  }

  let worst: T = first;
  for (let i = 1; i < events.length; i++) {
    const candidate = events[i];
    if (!candidate) continue;
    if (
      candidate.points > worst.points ||
      (candidate.points === worst.points && candidate.excessRatio > worst.excessRatio)
    ) {
      worst = candidate;
    }
  }
  return worst;
}

/**
 * Groups timestamped incidents into clusters separated by gaps > 1.0 s
 * (`windowS`) and returns the worst incident per cluster.
 */
export function clusterDebouncedIncidents<T extends IncidentCandidate & { timestamp: number }>(
  events: T[],
  windowS: number = DEBOUNCE_WINDOW_S,
): T[] {
  const first = events[0];
  if (!first) {
    return [];
  }

  const result: T[] = [];
  let cluster: T[] = [first];
  let prev: T = first;

  for (let i = 1; i < events.length; i++) {
    const current = events[i];
    if (!current) continue;
    const dt = current.timestamp - prev.timestamp;
    if (dt > windowS) {
      result.push(selectDebouncedIncident(cluster));
      cluster = [current];
    } else {
      cluster.push(current);
    }
    prev = current;
  }

  result.push(selectDebouncedIncident(cluster));
  return result;
}

/**
 * Returns true if the session has at least 300 s of moving telemetry data.
 */
export function hasMinimumMovingData(movingDurationS: number): boolean {
  return movingDurationS >= MIN_MOVING_DATA_S;
}
