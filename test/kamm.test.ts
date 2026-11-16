import { test } from 'node:test';
import assert from 'node:assert';
import { calculateTireRadius, computeDynamicKammLimits } from '../src/core/kamm';
import { VehicleSpecs } from '../src/core/types';

test('Kamm: Cálculo do raio do pneu comercial', () => {
  const r = calculateTireRadius('195/55 R16');
  assert.ok(Math.abs(r - 0.31045) < 1e-4, `Raio obtido: ${r}`);
});

test('Kamm: Invariante brakeLimit >= accelLimit e pisos mínimos de estrada', () => {
  const car: VehicleSpecs = {
    grossMassKg: 1600,
    curbMassKg: 1500,
    payloadKg: 100,
    powerHp: 200,
    tireSize: '225/45 R17',
    surfaceGrip: 0.95,
  } as any;

  const limits = computeDynamicKammLimits(car, 'road');
  assert.ok(limits.brakeLimit >= limits.accelLimit, 'brakeLimit menor que accelLimit');
  assert.ok(limits.accelLimit >= 0.32, 'Piso de aceleração violado');
  assert.ok(limits.brakeLimit >= 0.40, 'Piso de travagem violado');
});