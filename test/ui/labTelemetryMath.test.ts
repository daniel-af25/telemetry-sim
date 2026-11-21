/**
 * Testes unitários de `src/ui/labTelemetryMath.ts`:
 * - Escala unificada `forceScale = 1.2 / maxFz` e guardas contra `maxFz = 0` / `momentMax = 0`.
 * - Conservação de força resultante (`netFx ≈ m * ax`, `netFy ≈ m * ay`) e inputs (`throttle`/`brake`/`gripUse`).
 * - Sinais ISO 8855 em travagem em curva (`-ax`, `+ay`), rácio `coolwarm` das molas e estados (`no ar`, `slip`, `limite`).
 * - Colormaps `gripColorHex` e `coolwarmColorHex` nos extremos `[0, 0.5, 1]` e valores fora de gama.
 */
import { describe, expect, it } from 'vitest';
import type { SampleFrame } from '../../src/core/interpolator.ts';
import { computeLoadTransfer } from '../../src/core/loadTransfer.ts';
import { packToSoA, type ProcessedFrameInput } from '../../src/core/soa.ts';
import type { KammLimits } from '../../src/core/types.ts';
import type { ResolvedVehicleSpecs } from '../../src/core/vehicleSpecs.ts';
import {
  computeLabFrameDynamics,
  computeLabRunScales,
  coolwarmColorHex,
  FORCE_ARROW_M,
  gripColorHex,
} from '../../src/ui/labTelemetryMath.ts';

const G = 9.80665;

const SPECS: ResolvedVehicleSpecs = {
  id: 1,
  name: 'Lab Test GT',
  curbMassKg: 1400,
  payloadKg: 100,
  grossMassKg: 1500,
  powerHp: 220,
  wheelbaseL: 2.65,
  trackF: 1.56,
  trackR: 1.54,
  cgHeight: 0.54,
  frontWeightRatio: 0.58,
  frontRollShare: 0.58,
  maxSteerRad: 0.6109,
  tireSize: '225/45 R17',
  tireRadiusM: 0.316,
  surfaceGrip: 0.95,
  geometrySource: 'estimated',
};

const LIMITS: KammLimits = {
  accelLimit: 0.45,
  brakeLimit: 0.55,
  latLimit: 0.5,
  gripLimitG: 0.95,
};

function makeSoAFrame(overrides: Partial<ProcessedFrameInput> = {}): ProcessedFrameInput {
  const lt = computeLoadTransfer(
    overrides.ax ?? 0,
    overrides.ay ?? 0,
    overrides.speedMs ?? 15,
    overrides.omegaZ ?? 0,
    SPECS,
  );
  return {
    t: 0,
    lat: 41.17,
    lon: -8.55,
    x: 0,
    y: 0,
    speedMs: 15,
    ax: 0,
    ay: 0,
    az: G,
    omegaZ: 0,
    yaw: 0,
    steerRad: lt.steerRad,
    rollRad: lt.rollRad,
    pitchRad: lt.pitchRad,
    fzFL: lt.fzFL,
    fzFR: lt.fzFR,
    fzRL: lt.fzRL,
    fzRR: lt.fzRR,
    kammIndex: 0,
    roadGradePct: 0,
    distM: 0,
    gpsValid: true,
    isGap: false,
    isTunnelDr: false,
    isSlip: false,
    ...overrides,
  };
}

function makeSampleFrame(overrides: Partial<SampleFrame> = {}): SampleFrame {
  const ax = overrides.ax ?? 0;
  const ay = overrides.ay ?? 0;
  const speedMs = overrides.speedMs ?? 15;
  const omegaZ = overrides.omegaZ ?? 0;
  const lt = computeLoadTransfer(ax, ay, speedMs, omegaZ, SPECS);
  return {
    t: 0,
    lat: 41.17,
    lon: -8.55,
    x: 0,
    y: 0,
    speedMs,
    ax,
    ay,
    az: G,
    omegaZ,
    yaw: 0,
    steerRad: lt.steerRad,
    rollRad: lt.rollRad,
    pitchRad: lt.pitchRad,
    fzFL: lt.fzFL,
    fzFR: lt.fzFR,
    fzRL: lt.fzRL,
    fzRR: lt.fzRR,
    kammIndex: 0,
    roadGradePct: 0,
    distM: 0,
    gpsValid: true,
    isGap: false,
    isTunnelDr: false,
    isSlip: false,
    ...overrides,
  };
}

describe('labTelemetryMath — escalas, dinâmica de frame e colormaps', () => {
  it('calcula forceScale = 1.2 / maxFz e protege contra maxFz = 0 e momentMax = 0', () => {
    const track = packToSoA([
      makeSoAFrame({ t: 0, x: 0, y: 0, ax: 0, ay: 0 }),
      makeSoAFrame({ t: 0.2, x: 3, y: 1, ax: -4.0, ay: 4.5, omegaZ: 0.3 }),
    ]);
    const scales = computeLabRunScales(track, SPECS);
    const expectedMaxFz = Math.max(
      track.fzFL[0]!,
      track.fzFR[0]!,
      track.fzRL[0]!,
      track.fzRR[0]!,
      track.fzFL[1]!,
      track.fzFR[1]!,
      track.fzRL[1]!,
      track.fzRR[1]!,
    );
    expect(scales.maxFz).toBeCloseTo(expectedMaxFz, 3);
    expect(scales.forceScale).toBeCloseTo(FORCE_ARROW_M / expectedMaxFz, 6);
    expect(scales.momentMax).toBeGreaterThan(0);

    // Track vazio com massa zero: guarda contra divisão por zero (sem NaN/Infinity)
    const emptyTrack = packToSoA([]);
    const zeroMassSpecs: ResolvedVehicleSpecs = { ...SPECS, grossMassKg: 0 };
    const safeScales = computeLabRunScales(emptyTrack, zeroMassSpecs);
    expect(Number.isFinite(safeScales.forceScale)).toBe(true);
    expect(safeScales.forceScale).toBe(1e-3);
    expect(safeScales.momentMax).toBe(1);
  });

  it('conserva força resultante (netFx ≈ m*ax, netFy ≈ m*ay) e coincide com throttle/brake/gripUse do schema=6', () => {
    const ax = -0.35 * G; // travagem
    const ay = 0.4 * G; // curva à esquerda (+ay ISO 8855)
    const track = packToSoA([makeSoAFrame({ ax, ay, speedMs: 18, omegaZ: 0.25 })]);
    const scales = computeLabRunScales(track, SPECS);
    const dyn = computeLabFrameDynamics(
      makeSampleFrame({ ax, ay, speedMs: 18, omegaZ: 0.25 }),
      SPECS,
      LIMITS,
      scales,
    );

    expect(dyn.netFx).toBeCloseTo(SPECS.grossMassKg * ax, 2);
    expect(dyn.netFy).toBeCloseTo(SPECS.grossMassKg * ay, 2);
    expect(dyn.throttle).toBe(0);
    expect(dyn.brake).toBeCloseTo(0.35 / LIMITS.brakeLimit, 4);

    // Em curva à esquerda (+ay) com travagem (-ax), a roda dianteira exterior (FR) é a mais carregada
    expect(dyn.wheels.FR.fz).toBeGreaterThan(dyn.wheels.FL.fz);
    expect(dyn.wheels.FR.fz).toBeGreaterThan(dyn.wheels.RL.fz);
    expect(dyn.wheels.FR.grip).toBeCloseTo(SPECS.surfaceGrip * dyn.wheels.FR.fz, 2);
    expect(dyn.wheels.FR.gripUse).toBeCloseTo(
      Math.hypot(dyn.wheels.FR.fx, dyn.wheels.FR.fy) / dyn.wheels.FR.grip,
      5,
    );

    // Aceleração pura (+ax) => throttle proporcional e brake == 0
    const accelDyn = computeLabFrameDynamics(
      makeSampleFrame({ ax: 0.225 * G, ay: 0 }),
      SPECS,
      LIMITS,
      scales,
    );
    expect(accelDyn.throttle).toBeCloseTo(0.5, 4);
    expect(accelDyn.brake).toBe(0);
  });

  it('calcula strutRatio coolwarm (0.5 estático, <0.5 aliviada, >0.5 carregada) e estados (no ar, slip, limite)', () => {
    const track = packToSoA([makeSoAFrame({ ax: 0, ay: 0 })]);
    const scales = computeLabRunScales(track, SPECS);

    // Estático => strutRatio == 0.5 em todas as rodas
    const staticDyn = computeLabFrameDynamics(makeSampleFrame({ ax: 0, ay: 0 }), SPECS, LIMITS, scales);
    expect(staticDyn.wheels.FL.strutRatio).toBeCloseTo(0.5, 4);
    expect(staticDyn.wheels.FR.strutRatio).toBeCloseTo(0.5, 4);
    expect(staticDyn.wheels.RL.strutRatio).toBeCloseTo(0.5, 4);
    expect(staticDyn.wheels.RR.strutRatio).toBeCloseTo(0.5, 4);
    expect(staticDyn.wheels.FL.stateLabel).toBe('');

    // Travagem em curva à esquerda (-ax, +ay): FR carregada (>0.5), RL aliviada (<0.5)
    const cornerBrake = computeLabFrameDynamics(
      makeSampleFrame({ ax: -4.0, ay: 4.5, omegaZ: 0.3 }),
      SPECS,
      LIMITS,
      scales,
    );
    expect(cornerBrake.wheels.FR.strutRatio).toBeGreaterThan(0.5);
    expect(cornerBrake.wheels.RL.strutRatio).toBeLessThan(0.5);

    // Roda no ar (fz == 0)
    const airborne = computeLabFrameDynamics(
      makeSampleFrame({ fzRL: 0 }),
      SPECS,
      LIMITS,
      scales,
    );
    expect(airborne.wheels.RL.stateLabel).toBe('no ar');

    // Estado slip
    const slipping = computeLabFrameDynamics(
      makeSampleFrame({ isSlip: true }),
      SPECS,
      LIMITS,
      scales,
    );
    expect(slipping.wheels.FL.stateLabel).toBe('slip');

    // Estado limite (gripUse >= 0.98)
    const atLimit = computeLabFrameDynamics(
      makeSampleFrame({ ax: 0, ay: 0.96 * G }),
      SPECS,
      LIMITS,
      scales,
    );
    expect(atLimit.wheels.FR.stateLabel).toBe('limite');
  });

  it('devolve cores válidas em gripColorHex e coolwarmColorHex nos extremos e fora de gama', () => {
    expect(gripColorHex(0)).toBe('#10b981');
    expect(gripColorHex(1)).toBe('#f43f5e');
    expect(gripColorHex(-0.5)).toBe('#10b981');
    expect(gripColorHex(2.5)).toBe('#f43f5e');
    expect(gripColorHex(0.5)).toMatch(/^#[0-9a-f]{6}$/);

    expect(coolwarmColorHex(0)).toBe('#3b82f6');
    expect(coolwarmColorHex(0.5)).toBe('#e2e8f0');
    expect(coolwarmColorHex(1)).toBe('#ef4444');
    expect(coolwarmColorHex(-1)).toBe('#3b82f6');
    expect(coolwarmColorHex(3)).toBe('#ef4444');
  });
});
