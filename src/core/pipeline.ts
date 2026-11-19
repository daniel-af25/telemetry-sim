import {
  calibrateSamples,
  type CalibrationMode,
  type CalibrationStats,
} from './calibration.ts';
import {
  computeDynamicKammLimits,
  type DynamicKammLimitsResult,
} from './kamm.ts';
import { computeLoadTransfer } from './loadTransfer.ts';
import {
  parseCsv,
  type CsvProfile,
  type ParsedSessionVehicleMeta,
} from './parser.ts';
import {
  computeDrivingSkillPillars,
  computeEffectiveDistanceKm,
  computeOverallScore,
  detectIncidents,
  hasSufficientTelemetry,
  type DrivingSkillPillar,
  type Incident,
} from './scoring.ts';
import type {
  CalibratedSampleIso,
  LoadTransferResult,
  TripMode,
} from './types.ts';
import type { VehicleCatalogEntry } from './vehicleCatalog.ts';
import {
  resolveVehicleSpecs,
  type ResolvedVehicleSpecs,
  type VehicleSpecsOverrides,
} from './vehicleSpecs.ts';

const GRAVITY_MS2 = 9.80665;
const EARTH_RADIUS_KM = 6371.0;
const MAX_PLAUSIBLE_GPS_KMH = 260;

export interface PipelineOptions {
  tripMode?: TripMode;
  calibrationMode?: CalibrationMode;
  catalogEntry?: Partial<VehicleCatalogEntry> | null;
  vehicleOverrides?: VehicleSpecsOverrides | null;
}

export interface TelemetryPipelineSummary {
  sampleCount: number;
  movingDurationSec: number;
  totalElapsedSec: number;
  totalDistanceKm: number;
  effectiveDistanceKm: number;
  peakSpeedKmh: number;
  peakLatG: number;
  peakAccelG: number;
  peakBrakeG: number;
  maxMassConservationErrorN: number;
  incidentCount: number;
  isSufficientData: boolean;
  finalScore: number;
  grade: 'A+' | 'A' | 'B' | 'C' | 'D' | 'N/A';
  tierLabel: string;
}

export interface TelemetryPipelineResult {
  profile: CsvProfile;
  metadata: Record<string, string>;
  sessionVehicleMeta?: ParsedSessionVehicleMeta;
  scalingFactor: number;
  extraChannels: string[];
  vehicleSpecs: ResolvedVehicleSpecs;
  kammLimits: DynamicKammLimitsResult;
  calibrationStats: CalibrationStats;
  samplesIso: CalibratedSampleIso[];
  loadTransfers: LoadTransferResult[];
  incidents: Incident[];
  pillars: DrivingSkillPillar[];
  summary: TelemetryPipelineSummary;
}

/**
 * End-to-end headless telemetry pipeline:
 * `parseCsv -> resolveVehicleSpecs -> calibrateSamples -> computeDynamicKammLimits
 *  -> computeLoadTransfer -> detectIncidents -> computeDrivingSkillPillars -> summary`
 */
export function runTelemetryPipeline(
  csvText: string,
  options: PipelineOptions = {},
): TelemetryPipelineResult {
  const tripMode: TripMode = options.tripMode ?? 'road';
  const calibrationMode: CalibrationMode = options.calibrationMode ?? 'auto';

  // 1. Parse raw CSV
  const parsed = parseCsv(csvText);

  // 2. Resolve vehicle specs (curbMassKg + payloadKg; never GVWR)
  const sessionMeta = {
    ...parsed.metadata,
    ...(parsed.sessionVehicleMeta?.pilotWeightKg !== undefined
      ? { pilotWeightKg: parsed.sessionVehicleMeta.pilotWeightKg }
      : {}),
    ...(parsed.sessionVehicleMeta?.passengerWeightKg !== undefined
      ? { passengerWeightKg: parsed.sessionVehicleMeta.passengerWeightKg }
      : {}),
    ...(parsed.sessionVehicleMeta?.payloadKg !== undefined
      ? { payloadKg: parsed.sessionVehicleMeta.payloadKg }
      : {}),
  };

  const mergedOverrides: VehicleSpecsOverrides = {
    ...(parsed.sessionVehicleMeta?.vehicle !== undefined
      ? { name: parsed.sessionVehicleMeta.vehicle }
      : {}),
    ...(parsed.sessionVehicleMeta?.curbWeightKg !== undefined
      ? { curbMassKg: parsed.sessionVehicleMeta.curbWeightKg }
      : {}),
    ...(parsed.sessionVehicleMeta?.powerHp !== undefined
      ? { powerHp: parsed.sessionVehicleMeta.powerHp }
      : {}),
    ...(options.vehicleOverrides ?? {}),
  };

  const vehicleSpecs = resolveVehicleSpecs(
    options.catalogEntry,
    sessionMeta,
    mergedOverrides,
  );

  // 3. Calibrate to ISO 8855 / SI
  const calibration = calibrateSamples(parsed.data, {
    profile: parsed.profile,
    mode: calibrationMode,
  });
  const samplesIso = calibration.samples;

  // 4. Compute dynamic Kamm v2.2 limits
  const kammLimits = computeDynamicKammLimits(
    {
      ...vehicleSpecs,
      drivetrain: vehicleSpecs.drivetrain ?? options.catalogEntry?.drivetrain,
      torqueNm: options.catalogEntry?.torque_nm,
      accel0100S: options.catalogEntry?.accel_0_100_s,
      segment: options.catalogEntry?.segment,
      bodyStyle: options.catalogEntry?.body_style,
    },
    tripMode,
  );

  // 5. Per-sample 4-wheel load transfer, kinematics, and summary metrics
  const theoreticalWeightN = vehicleSpecs.grossMassKg * GRAVITY_MS2;
  const loadTransfers: LoadTransferResult[] = [];
  let maxMassConservationErrorN = 0;
  let movingDurationSec = 0;
  let totalDistanceKm = 0;
  let peakSpeedKmh = 0;
  let peakLatG = 0;
  let peakAccelG = 0;
  let peakBrakeG = 0;

  let lastGpsLat: number | null = null;
  let lastGpsLon: number | null = null;
  let lastGpsElapsedSec = 0;

  for (let i = 0; i < samplesIso.length; i++) {
    const s = samplesIso[i];
    if (!s) continue;

    const lt = computeLoadTransfer(s.ax, s.ay, s.speedMs, s.omegaZ, vehicleSpecs);
    loadTransfers.push(lt);

    const totalFz = lt.fzFL + lt.fzFR + lt.fzRL + lt.fzRR;
    const massErr = Math.abs(totalFz - theoreticalWeightN);
    if (massErr > maxMassConservationErrorN) {
      maxMassConservationErrorN = massErr;
    }

    const speedKmh = s.speedMs * 3.6;
    if (speedKmh > peakSpeedKmh) peakSpeedKmh = speedKmh;
    if (!s.isGap && speedKmh > 2.0) {
      movingDurationSec += s.dtSec > 0 ? s.dtSec : 0.2;
    }

    if (speedKmh > 5.0) {
      const axG = s.ax / GRAVITY_MS2;
      const ayG = Math.abs(s.ay / GRAVITY_MS2);
      if (ayG > peakLatG) peakLatG = ayG;
      if (axG > peakAccelG) peakAccelG = axG;
      if (axG < 0 && Math.abs(axG) > peakBrakeG) peakBrakeG = Math.abs(axG);
    }

    if (s.gpsValid && s.lat !== null && s.lon !== null) {
      if (lastGpsLat !== null && lastGpsLon !== null && speedKmh >= 2.0) {
        const dKm = haversineKm(lastGpsLat, lastGpsLon, s.lat, s.lon);
        const dtGps = s.elapsedSec - lastGpsElapsedSec;
        const impliedKmh = dtGps > 0 ? dKm / (dtGps / 3600) : 0;
        if (impliedKmh <= MAX_PLAUSIBLE_GPS_KMH) {
          totalDistanceKm += dKm;
        }
      }
      lastGpsLat = s.lat;
      lastGpsLon = s.lon;
      lastGpsElapsedSec = s.elapsedSec;
    }
  }

  // 6. Detect & cluster 7-category incidents
  const incidents = detectIncidents(samplesIso, kammLimits);

  // 7. Compute 5 Driving Skill Pillars & global summary
  const effectiveDistanceKm = computeEffectiveDistanceKm(totalDistanceKm, movingDurationSec);
  const isSufficientData = hasSufficientTelemetry(samplesIso.length, movingDurationSec);
  const pillars = computeDrivingSkillPillars(samplesIso, incidents, effectiveDistanceKm);
  const overall = computeOverallScore(pillars);

  const totalElapsedSec =
    samplesIso.length > 0 ? (samplesIso[samplesIso.length - 1]?.elapsedSec ?? 0) : 0;

  return {
    profile: parsed.profile,
    metadata: parsed.metadata,
    ...(parsed.sessionVehicleMeta ? { sessionVehicleMeta: parsed.sessionVehicleMeta } : {}),
    scalingFactor: parsed.scalingFactor,
    extraChannels: parsed.extraChannels,
    vehicleSpecs,
    kammLimits,
    calibrationStats: calibration.stats,
    samplesIso,
    loadTransfers,
    incidents,
    pillars,
    summary: {
      sampleCount: samplesIso.length,
      movingDurationSec,
      totalElapsedSec,
      totalDistanceKm,
      effectiveDistanceKm,
      peakSpeedKmh,
      peakLatG,
      peakAccelG,
      peakBrakeG,
      maxMassConservationErrorN,
      incidentCount: incidents.length,
      isSufficientData,
      finalScore: isSufficientData ? overall.score : 0,
      grade: isSufficientData ? overall.grade : 'N/A',
      tierLabel: isSufficientData ? overall.tierLabel : 'INSUFFICIENT DATA',
    },
  };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const toRad = Math.PI / 180;
  const dLat = (lat2 - lat1) * toRad;
  const dLon = (lon2 - lon1) * toRad;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * toRad) *
      Math.cos(lat2 * toRad) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  return 2 * EARTH_RADIUS_KM * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
