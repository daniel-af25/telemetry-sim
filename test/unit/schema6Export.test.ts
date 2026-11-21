/**
 * Issue #17 — Fase 6.2: Exportador Científico # schema=6 (src/core/schema6Export.ts)
 * Destino em telemetry-sim: test/schema6Export.test.ts
 *
 * Contrato travado por este teste (100% compatível com rallysim-master view3d.py / topdown.py):
 *   - exportSchema6Csv(
 *       frames: readonly Schema6SourceFrame[],
 *       specs: ResolvedVehicleSpecs,
 *       limits: KammLimits,
 *       window?: { startSec: number; endSec: number }
 *     ): string
 *
 * Linha 1: # schema=6 dt=... model=2 lf=... lr=... track_front=... track_rear=... cg_height=... wheel_radius=... max_steer=... springs=1 mu=...
 * Linha 2: 40 colunas exatas exigidas por view3d.py e topdown.py.
 * Origem transladada para (time=0, pos.x=0, pos.y=0) em unidades SI estritas.
 */
import { describe, expect, it } from 'vitest';
import { exportSchema6Csv } from '../../src/core/schema6Export.ts';
import type { KammLimits } from '../../src/core/types.ts';
import type { ResolvedVehicleSpecs } from '../../src/core/vehicleSpecs.ts';

const EXPECTED_40_COLUMNS = [
  'time',
  'pos.x',
  'pos.y',
  'pos.z',
  'yaw',
  'roll',
  'pitch',
  'speed',
  'u',
  'v',
  'steer',
  'throttle',
  'brake',
  'handbrake',
  'a_lat',
  'yaw_moment',
  'wheel.FL.Fx',
  'wheel.FL.Fy',
  'wheel.FL.Fz',
  'wheel.FL.omega',
  'wheel.FL.slipRatio',
  'wheel.FL.grip',
  'wheel.FR.Fx',
  'wheel.FR.Fy',
  'wheel.FR.Fz',
  'wheel.FR.omega',
  'wheel.FR.slipRatio',
  'wheel.FR.grip',
  'wheel.RL.Fx',
  'wheel.RL.Fy',
  'wheel.RL.Fz',
  'wheel.RL.omega',
  'wheel.RL.slipRatio',
  'wheel.RL.grip',
  'wheel.RR.Fx',
  'wheel.RR.Fy',
  'wheel.RR.Fz',
  'wheel.RR.omega',
  'wheel.RR.slipRatio',
  'wheel.RR.grip',
];

const specs: ResolvedVehicleSpecs = {
  id: 1,
  name: 'Test Car',
  curbMassKg: 1400,
  payloadKg: 100,
  grossMassKg: 1500,
  powerHp: 180,
  wheelbaseL: 2.65,
  trackF: 1.55,
  trackR: 1.55,
  cgHeight: 0.54,
  frontWeightRatio: 0.58,
  frontRollShare: 0.58,
  maxSteerRad: 0.6109,
  tireSize: '205/55 R16',
  tireRadiusM: 0.316,
  surfaceGrip: 0.95,
  geometrySource: 'estimated',
};

const limits: KammLimits = {
  accelLimit: 0.45,
  brakeLimit: 0.55,
  latLimit: 0.5,
  gripLimitG: 0.95,
};

describe('schema6Export — compatibilidade exata com view3d.py / topdown.py', () => {
  it('gera cabeçalho # schema=6 completo, exatamente as 40 colunas SI e origem transladada para (0, 0, 0)', () => {
    const mg = specs.grossMassKg * 9.80665;
    const frames = Array.from({ length: 10 }, (_, i) => ({
      t: 100.0 + i * 0.2,
      x: 500.0 + i * 2.0,
      y: -250.0 + i * 1.0,
      yaw: 0.46,
      speedMs: 12.0,
      ax: -2.5,
      ay: 1.8,
      steerRad: 0.05,
      rollRad: 0.01,
      pitchRad: 0.01,
      fzFL: mg * 0.28,
      fzFR: mg * 0.32,
      fzRL: mg * 0.18,
      fzRR: mg * 0.22,
      fxFL: -1200,
      fxFR: -1200,
      fxRL: -675,
      fxRR: -675,
      fyFL: 756,
      fyFR: 864,
      fyRL: 486,
      fyRR: 594,
      yawMoment: 120.5,
    }));

    const csv = exportSchema6Csv(frames, specs, limits, { startSec: 100.4, endSec: 101.6 });
    const lines = csv.trim().split(/\r?\n/);

    // Linha 1: metadados obrigatórios de view3d.py
    const meta = lines[0] ?? '';
    expect(meta.startsWith('# schema=6 ')).toBe(true);
    for (const key of [
      'dt=',
      'model=2',
      'lf=',
      'lr=',
      'track_front=',
      'track_rear=',
      'cg_height=',
      'wheel_radius=',
      'max_steer=',
      'springs=1',
      'mu=',
    ]) {
      expect(meta).toContain(key);
    }

    // Linha 2: 40 colunas exatas
    const headers = (lines[1] ?? '').split(',');
    expect(headers).toEqual(EXPECTED_40_COLUMNS);

    // Primeira amostra do recorte deve começar em time=0, pos.x=0, pos.y=0
    const firstRow = (lines[2] ?? '').split(',').map(Number);
    expect(firstRow).toHaveLength(40);
    expect(firstRow[0]).toBeCloseTo(0, 6); // time
    expect(firstRow[1]).toBeCloseTo(0, 6); // pos.x
    expect(firstRow[2]).toBeCloseTo(0, 6); // pos.y
    expect(firstRow[3]).toBeCloseTo(specs.cgHeight, 4); // pos.z

    // Conservação de massa nas 4 rodas e zero NaN em todas as linhas
    for (let r = 2; r < lines.length; r++) {
      const vals = (lines[r] ?? '').split(',').map(Number);
      for (const v of vals) {
        expect(Number.isFinite(v)).toBe(true);
      }
      const fzSum =
        (vals[18] ?? 0) + (vals[24] ?? 0) + (vals[30] ?? 0) + (vals[36] ?? 0);
      expect(Math.abs(fzSum - mg)).toBeLessThan(1e-1);
    }
  });
});
