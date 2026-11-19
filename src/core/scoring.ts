/**
 * Motor de incidentes (7 categorias), deteção de derrapagem ISO 8855 (`evaluateIncidentSlip`),
 * debounce temporal gap-safe (1.0 s), 5 Pilares de condução (zero dupla contagem),
 * score global (A+..D) e regra de suficiência (`>= 1500` amostras E `>= 120 s` em movimento).
 *
 * Testes:
 *   npx vitest run test/scoring.test.ts
 */
import { computeKammIndex } from './kamm.ts';
import type { CalibratedSampleIso, IncidentCategory, KammLimits } from './types.ts';

const GRAVITY_MS2 = 9.80665;
const RAD_TO_DEG = 180 / Math.PI;

export const DEBOUNCE_WINDOW_S = 1.0;
export const MIN_SUFFICIENT_SAMPLES = 1500;
export const MIN_SUFFICIENT_MOVING_SEC = 120;
export const MIN_MOVING_DATA_S = MIN_SUFFICIENT_MOVING_SEC;

const MIN_SLIP_SPEED_MS = 25 / 3.6; // ~6.944 m/s (25 km/h)
const SLIP_RESIDUAL_THRESHOLD_G = 0.35;

export interface SlipEvaluation {
  isSlip: boolean;
  slipResidualG: number;
}

export interface IncidentCandidate {
  category: IncidentCategory;
  points: number;
  excessRatio: number;
  timestamp?: string | number;
}

export interface Incident extends IncidentCandidate {
  timeStr: string;
  elapsedSec: number;
  timestamp: string | number;
  lat: number | null;
  lon: number | null;
  reason: string;
  intensity: string;
}

export interface DrivingSkillPillar {
  name: string;
  desc: string;
  score: number;
  grade: string;
  color: string;
}

export interface OverallScoreResult {
  score: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D';
  tierLabel: string;
  tierColor: string;
}

export const PILLAR_CATEGORY_MAP: Record<
  'cornering' | 'braking' | 'traction' | 'chassis' | 'powertrain',
  readonly IncidentCategory[]
> = {
  cornering: ['lateral'],
  braking: ['braking'],
  traction: ['slip', 'combined_brake', 'combined_traction'],
  chassis: ['bump'],
  powertrain: ['acceleration'],
};

/**
 * Evaluates kinematic yaw slip while preserving ISO 8855 sign conventions:
 * `slipResidualG = |ay_ISO / g - (u * omegaZ_ISO) / g| > 0.35 G`,
 * gated to `u > 25 / 3.6 m/s` (~6.944 m/s) to suppress low-speed noise.
 */
export function evaluateIncidentSlip(
  ayIsoMs2: number,
  speedMs: number,
  omegaZRadS: number,
): SlipEvaluation {
  if (speedMs <= MIN_SLIP_SPEED_MS) {
    return { isSlip: false, slipResidualG: 0 };
  }

  const ayG = ayIsoMs2 / GRAVITY_MS2;
  const expectedLatG = (speedMs * omegaZRadS) / GRAVITY_MS2;
  const slipResidualG = Math.abs(ayG - expectedLatG);

  return {
    isSlip: slipResidualG > SLIP_RESIDUAL_THRESHOLD_G,
    slipResidualG,
  };
}

/**
 * Selects the worst incident from a debounce cluster, prioritizing `points`
 * and breaking ties by `excessRatio`.
 */
export function selectDebouncedIncident<T extends IncidentCandidate>(
  events: readonly T[],
): T {
  const first = events[0];
  if (!first) {
    throw new Error('Cannot select debounced incident from an empty list');
  }

  let worst: T = first;
  for (let i = 1; i < events.length; i++) {
    const candidate = events[i];
    if (!candidate) continue;
    if (isMoreSevere(candidate, worst)) {
      worst = candidate;
    }
  }
  return worst;
}

/**
 * Groups timestamped incidents into clusters separated by gaps > `windowS`
 * and returns the worst incident per cluster.
 */
export function clusterDebouncedIncidents<T extends IncidentCandidate & { timestamp: number }>(
  events: readonly T[],
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
 * Detects and classifies all 7 incident categories (`braking`, `acceleration`,
 * `lateral`, `combined_brake`, `combined_traction`, `bump`, `slip`) with
 * gap-safe 1.0 s accumulated cooldown debouncing and descending severity sort.
 */
export function detectIncidents(
  samples: readonly CalibratedSampleIso[],
  limits: KammLimits,
): Incident[] {
  const allIncidents: Incident[] = [];
  let activeCluster: Incident | null = null;
  let clusterCooldownSec = 0;

  const firstMs = samples[0]?.timestampMs ?? Number.NaN;

  for (let i = 0; i < samples.length; i++) {
    const p = samples[i];
    if (!p) continue;

    const dt = p.dtSec > 0 ? p.dtSec : 0.2;

    // Close any open cluster immediately across temporal gaps (dt > 1.0 s)
    if (p.isGap && activeCluster) {
      allIncidents.push(activeCluster);
      activeCluster = null;
      clusterCooldownSec = 0;
    }

    const speedKmh = p.speedMs * 3.6;
    const axG = p.ax / GRAVITY_MS2;
    const ayG = p.ay / GRAVITY_MS2;
    const azG = p.az / GRAVITY_MS2;
    const pitchRateDps = (p.omegaY ?? 0) * RAD_TO_DEG;
    const yawRateDps = Math.abs(p.omegaZ * RAD_TO_DEG);

    const currentLonLimit = axG < 0 ? limits.brakeLimit : limits.accelLimit;
    const normLon = Math.abs(axG) / (currentLonLimit > 0 ? currentLonLimit : 1);
    const normLat = Math.abs(ayG) / (limits.latLimit > 0 ? limits.latLimit : 1);
    const kammIndex = computeKammIndex(axG, ayG, limits);

    const verticalDeltaG = Math.abs(azG - 1.0);
    const isHarshBump =
      verticalDeltaG > 0.80 && Math.abs(pitchRateDps) > 18.0 && speedKmh > 35.0;

    const slipEval = evaluateIncidentSlip(p.ay, p.speedMs, p.omegaZ);

    if (speedKmh > 5.0 && (kammIndex > 1.0 || isHarshBump || slipEval.isSlip)) {
      clusterCooldownSec = DEBOUNCE_WINDOW_S;

      let elapsedSec = 0;
      if (
        Number.isFinite(firstMs) &&
        p.timestampMs !== undefined &&
        Number.isFinite(p.timestampMs) &&
        p.timestampMs >= firstMs
      ) {
        elapsedSec = Math.round((p.timestampMs - firstMs) / 1000);
      } else if (Number.isFinite(p.elapsedSec)) {
        elapsedSec = Math.round(p.elapsedSec);
      }

      const mins = String(Math.floor(elapsedSec / 60)).padStart(2, '0');
      const secs = String(elapsedSec % 60).padStart(2, '0');
      const timeStr = `+${mins}:${secs}`;
      const timestamp = p.timestamp ?? p.elapsedSec;

      let candidate: Incident | null = null;

      if (kammIndex > 1.0) {
        if ((normLon < 1.0 && normLat < 1.0) || (normLon > 0.65 && normLat > 0.65)) {
          const excess = kammIndex - 1.0;
          const isBrakeCombo = axG < 0;
          candidate = {
            timeStr,
            elapsedSec,
            timestamp,
            lat: p.lat,
            lon: p.lon,
            category: isBrakeCombo ? 'combined_brake' : 'combined_traction',
            reason: `Combined Cornering & Longitudinal Load (${isBrakeCombo ? 'Trail-Braking' : 'Traction-Cornering'})`,
            intensity: `${Math.abs(ayG).toFixed(2)} G Lat + ${axG >= 0 ? '+' : '-'}${Math.abs(axG).toFixed(2)} G Lon`,
            excessRatio: excess,
            points: kammPoints(excess),
          };
        } else if (normLon >= normLat) {
          if (axG < 0) {
            const excess = (Math.abs(axG) - limits.brakeLimit) / limits.brakeLimit;
            candidate = {
              timeStr,
              elapsedSec,
              timestamp,
              lat: p.lat,
              lon: p.lon,
              category: 'braking',
              reason: 'Harsh Braking Shock',
              intensity: `${Math.abs(axG).toFixed(2)} G (Decel)`,
              excessRatio: excess,
              points: kammPoints(excess),
            };
          } else {
            const excess = (axG - limits.accelLimit) / limits.accelLimit;
            candidate = {
              timeStr,
              elapsedSec,
              timestamp,
              lat: p.lat,
              lon: p.lon,
              category: 'acceleration',
              reason: 'Excessive Traction Acceleration',
              intensity: `+${axG.toFixed(2)} G (Traction)`,
              excessRatio: excess,
              points: kammPoints(excess),
            };
          }
        } else {
          const excess = (Math.abs(ayG) - limits.latLimit) / limits.latLimit;
          candidate = {
            timeStr,
            elapsedSec,
            timestamp,
            lat: p.lat,
            lon: p.lon,
            category: 'lateral',
            reason: 'High Lateral Cornering G',
            intensity: `${Math.abs(ayG).toFixed(2)} G (Lateral)`,
            excessRatio: excess,
            points: kammPoints(excess),
          };
        }
      } else if (isHarshBump) {
        const excess = (verticalDeltaG - 0.80) / 0.80;
        candidate = {
          timeStr,
          elapsedSec,
          timestamp,
          lat: p.lat,
          lon: p.lon,
          category: 'bump',
          reason: 'Harsh Speed Bump / Curb Impact',
          intensity: `${verticalDeltaG.toFixed(2)} G (Vertical Shock)`,
          excessRatio: excess,
          points: verticalDeltaG > 1.20 ? 3 : 2,
        };
      } else if (slipEval.isSlip) {
        const excess = (slipEval.slipResidualG - SLIP_RESIDUAL_THRESHOLD_G) / SLIP_RESIDUAL_THRESHOLD_G;
        candidate = {
          timeStr,
          elapsedSec,
          timestamp,
          lat: p.lat,
          lon: p.lon,
          category: 'slip',
          reason: 'Kinematic Slip (Oversteer / Understeer)',
          intensity: `${yawRateDps.toFixed(1)} °/s (Yaw Rate)`,
          excessRatio: excess,
          points: slipEval.slipResidualG > 0.50 ? 5 : 3,
        };
      }

      if (candidate && isMoreSevere(candidate, activeCluster)) {
        activeCluster = candidate;
      }
    } else if (activeCluster) {
      clusterCooldownSec -= dt;
      if (clusterCooldownSec <= 0) {
        allIncidents.push(activeCluster);
        activeCluster = null;
        clusterCooldownSec = 0;
      }
    }
  }

  if (activeCluster) {
    allIncidents.push(activeCluster);
  }

  allIncidents.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    return b.excessRatio - a.excessRatio;
  });

  return allIncidents;
}

/**
 * Computes hybrid distance-duration normalization used for pillar scoring:
 * `effectiveDistanceKm = max(2.0, 0.70 * totalDistanceKm + 0.30 * (movingMin / 2.5))`
 */
export function computeEffectiveDistanceKm(
  totalDistanceKm: number,
  movingDurationSec: number,
): number {
  const movingMinutes = Math.max(0, movingDurationSec) / 60.0;
  const equivalentUrbanKm = movingMinutes / 2.5;
  return Math.max(2.0, 0.70 * Math.max(0, totalDistanceKm) + 0.30 * equivalentUrbanKm);
}

/**
 * Computes the 5 Driving Skill Pillars with strict 1:1 category mapping
 * (zero multi-pillar double counting) and gap-safe longitudinal jerk tracking.
 */
export function computeDrivingSkillPillars(
  samples: readonly CalibratedSampleIso[],
  incidents: readonly Incident[],
  effectiveDistanceKm: number = 10.0,
): DrivingSkillPillar[] {
  const effDist = Math.max(3.0, effectiveDistanceKm || 10.0);
  const distFactor = Math.min(1.35, Math.max(0.08, Math.pow(10.0 / effDist, 0.42)));

  const sumByCategories = (cats: readonly IncidentCategory[], weight: number): number => {
    let total = 0;
    for (const inc of incidents) {
      if (cats.includes(inc.category)) {
        total += inc.points * weight * distFactor;
      }
    }
    return total;
  };

  const corneringScore = clampInt(
    Math.round(100 - sumByCategories(PILLAR_CATEGORY_MAP.cornering, 2.5)),
    20,
    100,
  );
  const brakingScore = clampInt(
    Math.round(100 - sumByCategories(PILLAR_CATEGORY_MAP.braking, 2.5)),
    20,
    100,
  );
  const tractionScore = clampInt(
    Math.round(100 - sumByCategories(PILLAR_CATEGORY_MAP.traction, 2.2)),
    20,
    100,
  );
  const chassisScore = clampInt(
    Math.round(100 - sumByCategories(PILLAR_CATEGORY_MAP.chassis, 3.5)),
    20,
    100,
  );

  // Powertrain Sympathy: acceleration incidents + longitudinal drivetrain jerk (gap-safe)
  let harshShifts = 0;
  for (let i = 1; i < samples.length; i++) {
    const pCur = samples[i];
    const pPrev = samples[i - 1];
    if (!pCur || !pPrev || pCur.isGap) continue;

    const dt = pCur.dtSec > 0 ? pCur.dtSec : 0.2;
    const curLonG = pCur.ax / GRAVITY_MS2;
    const prevLonG = pPrev.ax / GRAVITY_MS2;
    const speedKmh = pCur.speedMs * 3.6;

    if (speedKmh > 12.0 && (curLonG > -0.10 || prevLonG > -0.10)) {
      const jerk = Math.abs(curLonG - prevLonG) / dt;
      if (jerk > 1.75) {
        harshShifts++;
      }
    }
  }

  const powertrainLoss =
    sumByCategories(PILLAR_CATEGORY_MAP.powertrain, 2.5) +
    Math.min(15, harshShifts * 1.5 * distFactor);
  const powertrainScore = clampInt(Math.round(100 - powertrainLoss), 25, 100);

  return [
    {
      name: 'CORNERING STABILITY',
      desc: 'Apex load & lateral G envelope',
      score: corneringScore,
      ...getPillarGradeInfo(corneringScore),
    },
    {
      name: 'BRAKING DISCIPLINE',
      desc: 'Deceleration linearity & lockup avoidance',
      score: brakingScore,
      ...getPillarGradeInfo(brakingScore),
    },
    {
      name: 'TRACTION CONTROL',
      desc: 'Yaw alignment & combined grip saturation',
      score: tractionScore,
      ...getPillarGradeInfo(tractionScore),
    },
    {
      name: 'CHASSIS CARE',
      desc: 'Vertical shock & curb dampening',
      score: chassisScore,
      ...getPillarGradeInfo(chassisScore),
    },
    {
      name: 'POWERTRAIN SYMPATHY',
      desc: 'Drivetrain smoothness & progressive torque',
      score: powertrainScore,
      ...getPillarGradeInfo(powertrainScore),
    },
  ];
}

/**
 * Computes overall driver score (mean of the 5 pillars) and grade tier
 * (`A+ >= 93`, `A >= 84`, `B >= 70`, `C >= 50`, `D < 50`).
 */
export function computeOverallScore(pillars: readonly DrivingSkillPillar[]): OverallScoreResult {
  if (pillars.length === 0) {
    return { score: 0, grade: 'D', tierLabel: 'AGGRESSIVE / HIGH RISK', tierColor: '#ef4444' };
  }

  let sum = 0;
  for (const p of pillars) sum += p.score;
  const score = clampInt(Math.round(sum / pillars.length), 0, 100);

  if (score >= 93) {
    return { score, grade: 'A+', tierLabel: 'EXCELLENT / PRO', tierColor: '#10b981' };
  }
  if (score >= 84) {
    return { score, grade: 'A', tierLabel: 'VERY GOOD / ADVANCED', tierColor: '#38bdf8' };
  }
  if (score >= 70) {
    return { score, grade: 'B', tierLabel: 'GOOD / SAFE', tierColor: '#fbbf24' };
  }
  if (score >= 50) {
    return { score, grade: 'C', tierLabel: 'AVERAGE / CAUTION', tierColor: '#f97316' };
  }
  return { score, grade: 'D', tierLabel: 'AGGRESSIVE / HIGH RISK', tierColor: '#ef4444' };
}

/**
 * Approved telemetry sufficiency rule (aligned with `generate_trip_debrief.js` v2.2):
 * requires `>= 1500` samples (5 min at 5 Hz) AND `>= 120 s` moving duration.
 */
export function hasSufficientTelemetry(
  sampleCount: number,
  movingDurationSec: number,
): boolean {
  return sampleCount >= MIN_SUFFICIENT_SAMPLES && movingDurationSec >= MIN_SUFFICIENT_MOVING_SEC;
}

/**
 * Legacy helper alias kept for compatibility with CLI scripts.
 */
export function hasMinimumMovingData(movingDurationS: number): boolean {
  return movingDurationS >= MIN_SUFFICIENT_MOVING_SEC;
}

function kammPoints(excess: number): number {
  if (excess < 0.15) return 2;
  if (excess <= 0.35) return 4;
  if (excess > 0.50) return 7;
  return 6;
}

function isMoreSevere<T extends IncidentCandidate>(cand: T, cur: T | null): boolean {
  if (!cur) return true;
  if (cand.points !== cur.points) return cand.points > cur.points;
  return cand.excessRatio > cur.excessRatio;
}

function getPillarGradeInfo(score: number): { grade: string; color: string } {
  if (score >= 90) return { grade: 'GRADE A', color: '#10b981' };
  if (score >= 80) return { grade: 'GRADE B', color: '#38bdf8' };
  if (score >= 70) return { grade: 'GRADE C', color: '#fbbf24' };
  if (score >= 50) return { grade: 'GRADE D', color: '#f97316' };
  return { grade: 'GRADE F', color: '#f43f5e' };
}

function clampInt(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
