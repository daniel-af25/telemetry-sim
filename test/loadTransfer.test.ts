import { test } from 'node:test';
import assert from 'node:assert';
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

test('Fz: Conservação Estrita de Massa (Fz_total == m * g)', () => {
  const ax = -0.5 * 9.80665; // Travagem a -0.5 G
  const ay = 0.4 * 9.80665;  // Curva à esquerda a +0.4 G
  const res = computeLoadTransfer(ax, ay, 20.0, 0.15, mockCar);

  const totalFz = res.fzFL + res.fzFR + res.fzRL + res.fzRR;
  const theoreticalFz = mockCar.grossMassKg * 9.80665;
  const delta = Math.abs(totalFz - theoreticalFz);

  assert.ok(delta < 1e-3, `Conservação violada por ${delta} N`);
});

test('Fz: Coerência de Sinais ISO 8855 em Curva à Esquerda', () => {
  const ax = 0.0;
  const ay = 0.5 * 9.80665; // Curva à esquerda (+ay em ISO)
  const res = computeLoadTransfer(ax, ay, 15.0, 0.20, mockCar);

  // Rodas exteriores (lado direito: FR e RR) têm de ter mais carga que as interiores (FL e RL)
  assert.ok(res.fzFR > res.fzFL, 'Roda FR devia ter mais carga que FL');
  assert.ok(res.fzRR > res.fzRL, 'Roda RR devia ter mais carga que RL');
});

test('Steer: Amortecimento a baixa velocidade sem divisão por zero', () => {
  const resStopped = computeLoadTransfer(0, 0, 0.0, 0.5, mockCar);
  assert.strictEqual(resStopped.steerRad, 0.0, 'Parado tem de amortecer para 0 rad');
  assert.ok(!Number.isNaN(resStopped.steerRad), 'Não pode retornar NaN');
});