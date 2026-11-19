import { describe, expect, it } from 'vitest';
import { calculateTireRadius, computeDynamicKammLimits } from '../src/core/kamm.ts';
import type { VehicleSpecs } from '../src/core/types.ts';

describe('Kamm', () => {
  it('Kamm: Cálculo do raio do pneu comercial', () => {
    const r = calculateTireRadius('195/55 R16');
    expect(Math.abs(r - 0.31045)).toBeLessThan(1e-4);
  });

  it('Kamm: Invariante brakeLimit >= accelLimit e pisos mínimos de estrada', () => {
    const car: VehicleSpecs = {
      name: 'Test Kamm Vehicle',
      grossMassKg: 1600,
      curbMassKg: 1500,
      payloadKg: 100,
      powerHp: 200,
      wheelbaseL: 2.65,
      trackF: 1.55,
      trackR: 1.55,
      cgHeight: 0.54,
      frontWeightRatio: 0.58,
      frontRollShare: 0.58,
      tireSize: '225/45 R17',
      tireRadiusM: calculateTireRadius('225/45 R17'),
      surfaceGrip: 0.95,
    };

    const limits = computeDynamicKammLimits(car, 'road');
    expect(limits.brakeLimit).toBeGreaterThanOrEqual(limits.accelLimit);
    expect(limits.accelLimit).toBeGreaterThanOrEqual(0.32);
    expect(limits.brakeLimit).toBeGreaterThanOrEqual(0.40);
  });
});
