import { describe, expect, it } from 'vitest';
import { computeLoadTransfer } from '../src/core/loadTransfer.ts';
import type { VehicleSpecs } from '../src/core/types.ts';

const mockCar: VehicleSpecs = {
  name: 'Test Vehicle',
  grossMassKg: 1500,
  curbMassKg: 1400,
  payloadKg: 100,
  powerHp: 150,
  wheelbaseL: 2.60,
  trackF: 1.55,
  trackR: 1.55,
  cgHeight: 0.54,
  frontWeightRatio: 0.58, // lr / L
  frontRollShare: 0.58,   // lambda_roll,f
  tireSize: '205/55 R16',
  tireRadiusM: 0.316,
  surfaceGrip: 0.95,
};

describe('computeLoadTransfer', () => {
  it('Fz: Conservação Estrita de Massa (Fz_total == m * g)', () => {
    const ax = -0.5 * 9.80665; // Travagem a -0.5 G
    const ay = 0.4 * 9.80665;  // Curva à esquerda a +0.4 G
    const res = computeLoadTransfer(ax, ay, 20.0, 0.15, mockCar);

    const totalFz = res.fzFL + res.fzFR + res.fzRL + res.fzRR;
    const theoreticalFz = mockCar.grossMassKg * 9.80665;
    const delta = Math.abs(totalFz - theoreticalFz);

    expect(delta).toBeLessThan(1e-3);
  });

  it('Fz: Coerência de Sinais ISO 8855 em Curva à Esquerda', () => {
    const ax = 0.0;
    const ay = 0.5 * 9.80665; // Curva à esquerda (+ay em ISO)
    const res = computeLoadTransfer(ax, ay, 15.0, 0.20, mockCar);

    // Rodas exteriores (lado direito: FR e RR) têm de ter mais carga que as interiores (FL e RL)
    expect(res.fzFR).toBeGreaterThan(res.fzFL);
    expect(res.fzRR).toBeGreaterThan(res.fzRL);
  });

  it('Steer: Amortecimento a baixa velocidade sem divisão por zero', () => {
    const resStopped = computeLoadTransfer(0, 0, 0.0, 0.5, mockCar);
    expect(resStopped.steerRad).toBe(0.0);
    expect(Number.isNaN(resStopped.steerRad)).toBe(false);
  });
});
