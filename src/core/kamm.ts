import type { KammLimits, TripMode, VehicleSpecs } from './types.ts';

const GRAVITY_MS2 = 9.80665;
const MM_PER_INCH = 25.4;
const DEFAULT_TIRE_RADIUS_M = 0.316;
const DEFAULT_TIRE_WIDTH_MM = 205.0;
const HP_TO_WATTS = 745.7;
const REF_SPEED_MS = 15.0;
const IMPLICIT_COMMERCIAL_ASPECT_RATIO = 80;

export interface KammVehicleInput extends VehicleSpecs {
  drivetrain?: string;
  torqueNm?: number;
  accel0100S?: number;
  segment?: string;
  bodyStyle?: string;
}

export interface KammDiagnostics {
  curbMassKg: number;
  grossMassKg: number;
  effectivePayloadKg: number;
  powerToWeight: number;
  avgTireWidthMm: number;
  tireRadiusM: number;
  kDrive: number;
  kTire: number;
  kChassis: number;
  kBody: number;
  deltaPayload: number;
}

export interface DynamicKammLimitsResult extends KammLimits {
  diagnostics: KammDiagnostics;
}

/**
 * Extracts average tire width in mm from catalog tire strings, supporting
 * staggered sizes (`245/40 ZR 18 // 325/30 ZR 18` -> `285 mm`), commercial
 * (`185 R15 C`), and compact (`P24570 R17`) formats.
 */
export function parseAverageTireWidthMm(tireSizeStr?: string): number {
  if (typeof tireSizeStr !== 'string' || !tireSizeStr.trim()) {
    return DEFAULT_TIRE_WIDTH_MM;
  }

  const widths: number[] = [];

  // Pattern 1: Standard slash formats (205/55 R16, 245/40 ZR 18, 255/40/20, 185/65 15)
  for (const m of tireSizeStr.matchAll(/(\d{3})\s*\//g)) {
    const w = Number(m[1]);
    if (Number.isFinite(w) && w >= 125 && w <= 385) {
      widths.push(w);
    }
  }

  // Pattern 2: Compact or non-slash formats (185 R15 C, P24570 R17)
  if (widths.length === 0) {
    for (const m of tireSizeStr.matchAll(/(?:^|[\s/P-])(\d{3})(?:\d{2})?\s*[A-Za-z]*[Rr]\s*\d{2}/gi)) {
      const w = Number(m[1]);
      if (Number.isFinite(w) && w >= 125 && w <= 385) {
        widths.push(w);
      }
    }
  }

  if (widths.length === 0) {
    return DEFAULT_TIRE_WIDTH_MM;
  }

  let sum = 0;
  for (const w of widths) sum += w;
  return sum / widths.length;
}

/**
 * Parses a commercial tire size string into nominal average outer radius in meters.
 * Supports standard (`195/55 R16`), staggered (`//`), `ZR`, no-`R` (`185/65 15`),
 * triple-slash (`255/40/20`), hyphenated (`215/70 - R15`), compact (`P24570 R17`),
 * and commercial implicit-80% (`185 R15 C`) formats.
 */
export function calculateTireRadius(tireSizeStr?: string): number {
  if (typeof tireSizeStr !== 'string' || !tireSizeStr.trim()) {
    return DEFAULT_TIRE_RADIUS_M;
  }

  const radii: number[] = [];

  // Pattern 1: width / aspect + (optional hyphen/space/slash + optional speed/R) + rim
  for (const m of tireSizeStr.matchAll(
    /(\d{3})\s*\/\s*(\d{2})\s*(?:[-\s/]*[A-Za-z]*[Rr]\s*|[-\s/]+)(\d{2})\b/g,
  )) {
    const widthMm = Number(m[1]);
    const aspectRatio = Number(m[2]);
    const rimDiameterIn = Number(m[3]);
    pushValidRadius(radii, widthMm, aspectRatio, rimDiameterIn);
  }

  // Pattern 2: Compact 5-digit without slash (e.g. P24570 R17)
  if (radii.length === 0) {
    for (const m of tireSizeStr.matchAll(
      /(?:^|[\s/P-])(\d{3})(\d{2})\s*[A-Za-z]*[Rr]\s*(\d{2})\b/gi,
    )) {
      const widthMm = Number(m[1]);
      const aspectRatio = Number(m[2]);
      const rimDiameterIn = Number(m[3]);
      pushValidRadius(radii, widthMm, aspectRatio, rimDiameterIn);
    }
  }

  // Pattern 3: Commercial without aspect ratio (implicit 80%, e.g. 185 R15 C)
  if (radii.length === 0) {
    for (const m of tireSizeStr.matchAll(
      /(?:^|[\s/P-])(\d{3})\s*[A-Za-z]*[Rr]\s*(\d{2})\b/gi,
    )) {
      const widthMm = Number(m[1]);
      const rimDiameterIn = Number(m[2]);
      pushValidRadius(radii, widthMm, IMPLICIT_COMMERCIAL_ASPECT_RATIO, rimDiameterIn);
    }
  }

  if (radii.length === 0) {
    return DEFAULT_TIRE_RADIUS_M;
  }

  let sum = 0;
  for (const r of radii) sum += r;
  return sum / radii.length;
}

/**
 * Computes continuous 3-axis Kamm v2.2 friction ellipse bounds (`+accel`, `-brake`, `±lat`)
 * with propulsion, tire footprint, chassis/body modifiers, payload sensitivity,
 * competition expansion, and strict low-grip physical clamping (`<= gripLimitG`).
 */
export function computeDynamicKammLimits(
  specs: KammVehicleInput,
  mode: TripMode,
): DynamicKammLimitsResult {
  const gripLimitG = specs.surfaceGrip > 0 ? specs.surfaceGrip : 0.95;
  const curbMassKg = Math.max(1, specs.curbMassKg || specs.grossMassKg);
  const grossMassKg = Math.max(curbMassKg, specs.grossMassKg);
  const effectivePayloadKg = Math.max(0, specs.payloadKg ?? grossMassKg - curbMassKg);
  const massRatio = curbMassKg / grossMassKg;
  const powerHp = Math.max(1, specs.powerHp);
  const powerToWeight = powerHp / (grossMassKg / 1000.0);

  const drivetrain = (specs.drivetrain ?? 'FWD').trim().toUpperCase();
  const segment = (specs.segment ?? '').trim().toLowerCase();
  const bodyStyle = (specs.bodyStyle ?? '').trim().toLowerCase();

  // 1. Longitudinal traction limit (+ax)
  const powerAccelG = (powerHp * HP_TO_WATTS) / (grossMassKg * REF_SPEED_MS * GRAVITY_MS2);
  const t0100 = specs.accel0100S;
  const hasValid0100 =
    t0100 !== undefined && Number.isFinite(t0100) && t0100 >= 1.8 && t0100 <= 25.0;
  const a0100 = hasValid0100
    ? (27.7778 / (t0100 * GRAVITY_MS2)) * massRatio
    : powerAccelG * 0.85;

  const isAwd =
    drivetrain.includes('AWD') || drivetrain.includes('4WD') || drivetrain.includes('4X4');
  const kDrive = isAwd ? 1.08 : drivetrain.includes('RWD') ? 1.02 : 0.92;

  const torqueNm = specs.torqueNm ?? 0;
  const torqueBonus =
    torqueNm > 0
      ? Math.min(0.06, Math.max(0.0, (torqueNm / (grossMassKg / 1000.0) - 120.0) / 2500.0))
      : 0.0;

  const rawAccelG = (0.18 + 0.34 * powerAccelG + 0.32 * a0100 + torqueBonus) * kDrive;
  const roadAccel = round2(Math.min(0.85, Math.max(0.30, rawAccelG)));

  // 2. Tire footprint & chassis class
  const avgTireWidthMm = parseAverageTireWidthMm(specs.tireSize);
  const tireRadiusM =
    specs.tireSize && specs.tireSize.trim() !== ''
      ? calculateTireRadius(specs.tireSize)
      : specs.tireRadiusM > 0
        ? specs.tireRadiusM
        : DEFAULT_TIRE_RADIUS_M;

  const kTire = Math.min(
    1.18,
    Math.max(
      0.90,
      Math.pow(avgTireWidthMm / 205.0, 0.32) * Math.pow(tireRadiusM / 0.316, 0.15),
    ),
  );

  let kChassis = 1.00;
  if (segment.includes('exotic') || segment.includes('supercar')) {
    kChassis = 1.32;
  } else if (
    segment.includes('sport') ||
    segment.includes('coupe') ||
    bodyStyle.includes('roadster') ||
    bodyStyle.includes('spyder') ||
    bodyStyle.includes('spider')
  ) {
    kChassis = 1.15;
  } else if (
    segment.includes('executive') ||
    segment.includes('premium') ||
    segment.includes('luxury') ||
    segment.includes('midsize') ||
    segment.includes('large')
  ) {
    kChassis = 1.06;
  } else if (segment.includes('compact')) {
    kChassis = 1.02;
  } else if (
    segment.includes('small') ||
    segment.includes('mini') ||
    segment.includes('city') ||
    segment.includes('micro') ||
    segment.includes('kei')
  ) {
    kChassis = 0.94;
  }

  // 3. Body style / CG roll modifier
  let kBody = 1.00;
  if (
    segment.includes('exotic') ||
    segment.includes('supercar') ||
    bodyStyle.includes('coup') ||
    bodyStyle.includes('spyder') ||
    bodyStyle.includes('spider') ||
    bodyStyle.includes('roadster') ||
    segment.includes('roadster')
  ) {
    kBody = 1.04;
  } else if (
    bodyStyle.includes('suv') ||
    bodyStyle.includes('crossover') ||
    segment.includes('crossover') ||
    segment.includes('suv') ||
    segment.includes('pickup') ||
    bodyStyle.includes('truck')
  ) {
    kBody = 0.91;
  } else if (segment.includes('mpv') || bodyStyle.includes('van')) {
    kBody = 0.93;
  } else if (
    bodyStyle.includes('wagon') ||
    bodyStyle.includes('estate') ||
    bodyStyle.includes('sw')
  ) {
    kBody = 0.97;
  }

  // Payload CG & tire load sensitivity penalty
  const ratioPayload = Math.min(0.35, effectivePayloadKg / curbMassKg);
  const deltaPayload = 0.12 * ratioPayload;

  // 4. Lateral & braking limits (base road v2.2)
  const rawLatG = 0.47 * kTire * kChassis * kBody - deltaPayload;
  const roadLat = round2(Math.min(0.82, Math.max(0.38, rawLatG)));

  const rawBrakeG = 0.52 * kTire * kChassis - 0.50 * deltaPayload;
  const roadBrake = round2(Math.min(0.85, Math.max(0.42, roadAccel, roadLat, rawBrakeG)));

  let accelLimit = roadAccel;
  let latLimit = roadLat;
  let brakeLimit = roadBrake;

  if (mode === 'competition') {
    latLimit = round2(Math.min(gripLimitG, Math.max(roadLat, gripLimitG * 0.90)));
    accelLimit = round2(
      Math.min(gripLimitG, Math.max(roadAccel, Math.min(roadAccel * 1.25, gripLimitG * 0.88))),
    );
    brakeLimit = round2(
      Math.min(gripLimitG, Math.max(roadBrake, accelLimit, latLimit, gripLimitG * 0.95)),
    );
  } else if (gripLimitG < 0.85) {
    // Low-grip scaling (wet/snow/ice): never exceed physical tire grip
    const gripScale = gripLimitG / 0.95;
    accelLimit = round2(Math.min(gripLimitG, roadAccel * gripScale));
    latLimit = round2(Math.min(gripLimitG, roadLat * gripScale));
    brakeLimit = round2(Math.min(gripLimitG, Math.max(roadBrake * gripScale, accelLimit, latLimit)));
  }

  // Final physical invariants: never exceed gripLimitG and brakeLimit >= accelLimit
  accelLimit = Math.min(gripLimitG, accelLimit);
  latLimit = Math.min(gripLimitG, latLimit);
  brakeLimit = Math.min(gripLimitG, Math.max(brakeLimit, accelLimit));

  return {
    accelLimit,
    brakeLimit,
    latLimit,
    gripLimitG,
    diagnostics: {
      curbMassKg,
      grossMassKg,
      effectivePayloadKg,
      powerToWeight: Number(powerToWeight.toFixed(1)),
      avgTireWidthMm: Math.round(avgTireWidthMm),
      tireRadiusM: Number(tireRadiusM.toFixed(3)),
      kDrive,
      kTire: Number(kTire.toFixed(3)),
      kChassis: Number(kChassis.toFixed(3)),
      kBody,
      deltaPayload: Number(deltaPayload.toFixed(4)),
    },
  };
}

/**
 * Computes the dimensionless asymmetric Kamm friction circle utilization index.
 * Uses `accelLimit` for `axG >= 0` and `brakeLimit` for `axG < 0`.
 */
export function computeKammIndex(axG: number, ayG: number, limits: KammLimits): number {
  const lonLimit = axG < 0 ? limits.brakeLimit : limits.accelLimit;
  const safeLon = lonLimit > 0 ? lonLimit : 1;
  const safeLat = limits.latLimit > 0 ? limits.latLimit : 1;
  return Math.hypot(axG / safeLon, ayG / safeLat);
}

function pushValidRadius(
  radii: number[],
  widthMm: number,
  aspectRatio: number,
  rimDiameterIn: number,
): void {
  if (
    Number.isFinite(widthMm) &&
    Number.isFinite(aspectRatio) &&
    Number.isFinite(rimDiameterIn) &&
    widthMm >= 125 &&
    widthMm <= 385 &&
    aspectRatio >= 20 &&
    aspectRatio <= 95 &&
    rimDiameterIn >= 10 &&
    rimDiameterIn <= 26
  ) {
    const sidewallMm = widthMm * (aspectRatio / 100.0);
    const rimRadiusMm = (rimDiameterIn * MM_PER_INCH) / 2.0;
    radii.push((rimRadiusMm + sidewallMm) / 1000.0);
  }
}

function round2(value: number): number {
  return Number(value.toFixed(2));
}
