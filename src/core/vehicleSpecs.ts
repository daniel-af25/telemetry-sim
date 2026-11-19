import { calculateTireRadius } from './kamm.ts';
import type { VehicleSpecs } from './types.ts';
import type { VehicleCatalogEntry } from './vehicleCatalog.ts';

export type GeometrySource = 'measured' | 'estimated';

export interface SessionVehicleMeta {
  pilotWeightKg?: number;
  passengerWeightKg?: number;
  payloadKg?: number;
  surfaceGrip?: number;
  tireSize?: string;
  [key: string]: string | number | undefined;
}

export interface VehicleSpecsOverrides extends Partial<VehicleSpecs> {
  pilotWeightKg?: number;
  passengerWeightKg?: number;
  maxSteerRad?: number;
}

export interface ResolvedVehicleSpecs extends VehicleSpecs {
  maxSteerRad: number;
  geometrySource: GeometrySource;
  drivetrain?: string;
  dragCd?: number;
}

interface EstimatedGeometry {
  wheelbaseL: number;
  trackF: number;
  trackR: number;
  cgHeight: number;
  frontWeightRatio: number;
  frontRollShare: number;
  maxSteerRad: number;
}

const DEFAULT_CURB_MASS_KG = 1400;
const DEFAULT_PAYLOAD_KG = 75;
const DEFAULT_POWER_HP = 150;
const DEFAULT_TIRE_SIZE = '205/55 R16';
const DEFAULT_SURFACE_GRIP = 0.95;

/**
 * Estimates vehicle geometry parameters from catalog `segment`, `body_style`,
 * and `drivetrain` when measured values are not supplied.
 */
export function estimateVehicleGeometry(
  segment?: string,
  bodyStyle?: string,
  drivetrain?: string,
): EstimatedGeometry {
  const seg = (segment ?? '').toLowerCase();
  const body = (bodyStyle ?? '').toLowerCase();
  const drive = (drivetrain ?? '').toLowerCase();

  let wheelbaseL = 2.65;
  let trackF = 1.55;
  let trackR = 1.55;
  let cgHeight = 0.54;
  let maxSteerRad = 0.60;

  if (
    body.includes('suv') ||
    seg.includes('suv') ||
    body.includes('crossover') ||
    seg.includes('crossover') ||
    body.includes('off-road')
  ) {
    wheelbaseL = 2.78;
    trackF = 1.62;
    trackR = 1.62;
    cgHeight = 0.66;
    maxSteerRad = 0.60;
  } else if (
    body.includes('van') ||
    body.includes('mpv') ||
    body.includes('pickup') ||
    seg.includes('van')
  ) {
    wheelbaseL = 3.05;
    trackF = 1.66;
    trackR = 1.66;
    cgHeight = 0.72;
    maxSteerRad = 0.62;
  } else if (
    body.includes('coup') ||
    body.includes('roadster') ||
    body.includes('cabrio') ||
    body.includes('convertible') ||
    seg.includes('sport') ||
    seg.includes('exotic')
  ) {
    wheelbaseL = 2.62;
    trackF = 1.56;
    trackR = 1.58;
    cgHeight = 0.46;
    maxSteerRad = 0.56;
  } else if (
    seg.includes('small') ||
    seg.includes('mini') ||
    seg === 'a' ||
    seg === 'b'
  ) {
    wheelbaseL = 2.50;
    trackF = 1.48;
    trackR = 1.47;
    cgHeight = 0.52;
    maxSteerRad = 0.62;
  } else if (
    body.includes('sedan') ||
    body.includes('saloon') ||
    body.includes('wagon') ||
    body.includes('estate') ||
    seg === 'd' ||
    seg === 'e' ||
    seg.includes('executive') ||
    seg.includes('luxury')
  ) {
    wheelbaseL = 2.82;
    trackF = 1.58;
    trackR = 1.59;
    cgHeight = 0.52;
    maxSteerRad = 0.58;
  } else if (body.includes('hatchback') || seg === 'c' || seg.includes('compact')) {
    wheelbaseL = 2.65;
    trackF = 1.54;
    trackR = 1.53;
    cgHeight = 0.53;
    maxSteerRad = 0.60;
  }

  let frontWeightRatio = 0.58;
  let frontRollShare = 0.58;

  if (drive.includes('rwd') || drive.includes('rear')) {
    frontWeightRatio = 0.51;
    frontRollShare = 0.52;
  } else if (drive.includes('awd') || drive.includes('4wd') || drive.includes('all')) {
    frontWeightRatio = 0.55;
    frontRollShare = 0.55;
  } else if (drive.includes('fwd') || drive.includes('front')) {
    frontWeightRatio = 0.60;
    frontRollShare = 0.60;
  }

  return {
    wheelbaseL,
    trackF,
    trackR,
    cgHeight,
    frontWeightRatio,
    frontRollShare,
    maxSteerRad,
  };
}

/**
 * Resolves unified `VehicleSpecs` from a catalog entry, session metadata, and
 * explicit overrides. Running mass is always `curbMassKg + payloadKg` (never
 * catalog `gross_weight_kg` / GVWR), defaulting `payloadKg` to 75 kg.
 */
export function resolveVehicleSpecs(
  catalogEntry?: Partial<VehicleCatalogEntry> | null,
  sessionMeta?: SessionVehicleMeta | null,
  overrides?: VehicleSpecsOverrides | null,
): ResolvedVehicleSpecs {
  const curbMassKg =
    toPositiveNumber(overrides?.curbMassKg) ??
    toPositiveNumber(catalogEntry?.weight_kg) ??
    DEFAULT_CURB_MASS_KG;

  const pilotWeightKg =
    toNonNegativeNumber(overrides?.pilotWeightKg) ??
    toNonNegativeNumber(sessionMeta?.pilotWeightKg) ??
    toNonNegativeNumber(sessionMeta?.['pilot_weight_kg']);

  const passengerWeightKg =
    toNonNegativeNumber(overrides?.passengerWeightKg) ??
    toNonNegativeNumber(sessionMeta?.passengerWeightKg) ??
    toNonNegativeNumber(sessionMeta?.['passenger_weight_kg']);

  const explicitPayload =
    toNonNegativeNumber(overrides?.payloadKg) ??
    toNonNegativeNumber(sessionMeta?.payloadKg) ??
    toNonNegativeNumber(sessionMeta?.['payload_kg']);

  const payloadKg =
    explicitPayload !== undefined
      ? explicitPayload
      : pilotWeightKg !== undefined || passengerWeightKg !== undefined
        ? (pilotWeightKg ?? DEFAULT_PAYLOAD_KG) + (passengerWeightKg ?? 0)
        : DEFAULT_PAYLOAD_KG;

  // Running mass: strictly curbMassKg + payloadKg (never gross_weight_kg / GVWR)
  const grossMassKg = curbMassKg + payloadKg;

  const estimated = estimateVehicleGeometry(
    catalogEntry?.segment,
    catalogEntry?.body_style,
    catalogEntry?.drivetrain,
  );

  const hasMeasuredGeometry =
    toPositiveNumber(overrides?.wheelbaseL) !== undefined ||
    toPositiveNumber(overrides?.trackF) !== undefined ||
    toPositiveNumber(overrides?.trackR) !== undefined ||
    toPositiveNumber(overrides?.cgHeight) !== undefined ||
    toPositiveNumber(overrides?.frontWeightRatio) !== undefined ||
    toPositiveNumber(overrides?.frontRollShare) !== undefined ||
    toPositiveNumber(overrides?.maxSteerRad) !== undefined;

  const tireSize =
    overrides?.tireSize ??
    (typeof sessionMeta?.tireSize === 'string' ? sessionMeta.tireSize : undefined) ??
    (typeof sessionMeta?.['tire_size'] === 'string' ? sessionMeta['tire_size'] : undefined) ??
    catalogEntry?.tire_size ??
    DEFAULT_TIRE_SIZE;

  const tireRadiusM =
    toPositiveNumber(overrides?.tireRadiusM) ?? calculateTireRadius(tireSize);

  const powerHp =
    toPositiveNumber(overrides?.powerHp) ??
    toPositiveNumber(catalogEntry?.power_hp) ??
    DEFAULT_POWER_HP;

  const surfaceGrip =
    toPositiveNumber(overrides?.surfaceGrip) ??
    toPositiveNumber(sessionMeta?.surfaceGrip) ??
    toPositiveNumber(sessionMeta?.['surface_grip']) ??
    DEFAULT_SURFACE_GRIP;

  const name =
    overrides?.name ??
    (catalogEntry?.make || catalogEntry?.model
      ? `${catalogEntry.make ?? ''} ${catalogEntry.model ?? ''}`.trim()
      : 'Unknown Vehicle');

  return {
    id: overrides?.id ?? catalogEntry?.id,
    name,
    grossMassKg,
    curbMassKg,
    payloadKg,
    powerHp,
    wheelbaseL: toPositiveNumber(overrides?.wheelbaseL) ?? estimated.wheelbaseL,
    trackF: toPositiveNumber(overrides?.trackF) ?? estimated.trackF,
    trackR: toPositiveNumber(overrides?.trackR) ?? estimated.trackR,
    cgHeight: toPositiveNumber(overrides?.cgHeight) ?? estimated.cgHeight,
    frontWeightRatio:
      toPositiveNumber(overrides?.frontWeightRatio) ?? estimated.frontWeightRatio,
    frontRollShare:
      toPositiveNumber(overrides?.frontRollShare) ?? estimated.frontRollShare,
    maxSteerRad: toPositiveNumber(overrides?.maxSteerRad) ?? estimated.maxSteerRad,
    tireSize,
    tireRadiusM,
    surfaceGrip,
    geometrySource: hasMeasuredGeometry ? 'measured' : 'estimated',
    drivetrain: catalogEntry?.drivetrain,
    dragCd: catalogEntry?.drag_cd,
  };
}

function toPositiveNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value > 0 ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n > 0 ? n : undefined;
  }
  return undefined;
}

function toNonNegativeNumber(value: unknown): number | undefined {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : undefined;
  }
  return undefined;
}
