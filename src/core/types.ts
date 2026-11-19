export type TripMode = 'road' | 'competition';

export type IncidentCategory =
  | 'braking'
  | 'lateral'
  | 'acceleration'
  | 'combined_brake'
  | 'combined_traction'
  | 'bump'
  | 'slip';

export interface TelemetryPointRaw {
  timestamp: string | number;
  lat: number | null;
  lon: number | null;
  gpsValid?: boolean;
  speed: number;          // km/h
  accelX: number;         // g (bruto do sensor)
  accelY: number;         // g (bruto do sensor)
  accelZ: number;         // g (bruto do sensor)
  accelLatCompG?: number; // g (lateral compensada LABSIS v2.2)
  accelLonCompG?: number; // g (longitudinal compensada LABSIS v2.2)
  gyroZ: number;          // °/s
  gyroX?: number;
  gyroY?: number;
  alt?: number;
  roadGradePct?: number;
  kammIndex?: number;
  timestampMs?: number;
  elapsedSec?: number;
  dtSec?: number;
  isGap?: boolean;
  extras?: Record<string, number>;
}

export interface VehicleSpecs {
  id?: number;
  name: string;
  grossMassKg: number;
  curbMassKg: number;
  payloadKg: number;
  powerHp: number;
  wheelbaseL: number;       // m
  trackF: number;           // m
  trackR: number;           // m
  cgHeight: number;         // m
  frontWeightRatio: number; // lr / L
  frontRollShare: number;   // lambda_roll,f
  maxSteerRad?: number;     // rad (default ~35° = 0.6109 rad)
  tireSize: string;
  tireRadiusM: number;
  surfaceGrip: number;
}

export interface LoadTransferResult {
  fzFL: number;
  fzFR: number;
  fzRL: number;
  fzRR: number;
  fxFL: number;
  fxFR: number;
  fxRL: number;
  fxRR: number;
  fyFL: number;
  fyFR: number;
  fyRL: number;
  fyRR: number;
  yawMoment: number;
  steerRad: number;
  rollRad: number;
  pitchRad: number;
}

export interface KammLimits {
  accelLimit: number;
  brakeLimit: number;
  latLimit: number;
  gripLimitG: number;
}

export interface CalibratedSampleIso {
  sampleIndex?: number;
  timestamp?: string | number;
  timestampMs?: number;
  ax: number;
  ay: number;
  az: number;
  omegaX?: number;
  omegaY?: number;
  omegaZ: number;
  speedMs: number;
  roadGradePct: number;
  pitchSlopeRad?: number;
  elapsedSec: number;
  dtSec: number;
  isGap: boolean;
  lat: number | null;
  lon: number | null;
  gpsValid: boolean;
}
