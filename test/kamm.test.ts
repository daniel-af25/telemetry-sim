/**
 * Issue #22 — Fase 1.5d: Kamm v2.2 Completo & Parsing Robusto de Pneus (src/core/kamm.ts)
 * Destino em telemetry-sim: test/kamm.test.ts
 *
 * Contrato travado por este teste:
 *   - parseAverageTireWidthMm(tireSize?: string): number
 *   - calculateTireRadius(tireSize?: string): number
 *   - computeDynamicKammLimits(specs: ResolvedVehicleSpecs | VehicleSpecs, mode: TripMode): KammLimits
 *   - computeKammIndex(axG: number, ayG: number, limits: KammLimits): number
 *
 * Nota: Adicionar campos opcionais de catálogo a ResolvedVehicleSpecs (torqueNm, accel0100S,
 * segment, bodyStyle) para paridade exata com generate_trip_debrief.js v2.2!
 */
import { describe, expect, it } from 'vitest';
import {
  calculateTireRadius,
  computeDynamicKammLimits,
  computeKammIndex,
  parseAverageTireWidthMm,
} from '../src/core/kamm.ts';
import type { VehicleSpecs } from '../src/core/types.ts';

const audiA3Base: VehicleSpecs & {
  drivetrain?: string;
  torqueNm?: number;
  accel0100S?: number;
  segment?: string;
  bodyStyle?: string;
} = {
  id: 25374,
  name: 'AUDI A3 Sportback 40 TFSI e',
  curbMassKg: 1635,
  payloadKg: 150,
  grossMassKg: 1785,
  powerHp: 204,
  torqueNm: 350,
  accel0100S: 7.6,
  drivetrain: 'FWD',
  segment: 'Compact',
  bodyStyle: 'Hatchback',
  wheelbaseL: 2.65,
  trackF: 1.54,
  trackR: 1.53,
  cgHeight: 0.53,
  frontWeightRatio: 0.6,
  frontRollShare: 0.6,
  tireSize: '',
  tireRadiusM: 0.316,
  surfaceGrip: 0.95,
};

describe('kamm — geometria e largura de pneu (formatos reais de data/vehicles.csv)', () => {
  it('calcula raio exato para especificação comercial padrão (195/55 R16 -> 0.31045 m)', () => {
    expect(calculateTireRadius('195/55 R16')).toBeCloseTo(0.31045, 4);
  });

  it('faz parse de todos os formatos problemáticos do catálogo (staggered, ZR, sem R, hífen, comercial C)', () => {
    // Staggered ZR: média entre 245/40 R18 (0.3266 m) e 325/30 R18 (0.3261 m)
    const staggeredR = calculateTireRadius('245/40 ZR 18 // 325/30 ZR 18');
    expect(staggeredR).toBeCloseTo(0.32635, 3);
    expect(parseAverageTireWidthMm('245/40 ZR 18 // 325/30 ZR 18')).toBeCloseTo(285, 1);

    // Sem letra R: 185/65 15 -> rim 7.5*25.4=190.5 mm + sidewall 120.25 mm = 0.31075 m
    expect(calculateTireRadius('185/65 15')).toBeCloseTo(0.31075, 4);

    // Barra tripla staggered: 255/40/20 // 295/35/20
    expect(calculateTireRadius('255/40/20 // 295/35/20')).toBeGreaterThan(0.35);

    // Com hífen: 215/70 - R15 -> 190.5 + 150.5 = 0.3410 m
    expect(calculateTireRadius('215/70 - R15')).toBeCloseTo(0.341, 3);

    // Comercial sem perfil (assume 80%): 185 R15 C -> 190.5 + 148 = 0.3385 m
    expect(calculateTireRadius('185 R15 C')).toBeCloseTo(0.3385, 3);
    expect(parseAverageTireWidthMm('185 R15 C')).toBeCloseTo(185, 1);
  });

  it('usa defaults seguros para string vazia ou inválida', () => {
    expect(calculateTireRadius('')).toBeCloseTo(0.316, 3);
    expect(parseAverageTireWidthMm('')).toBeCloseTo(205, 1);
  });
});

describe('kamm — computeDynamicKammLimits v2.2 & invariantes físicos', () => {
  it('reproduz exatamente os limites v2.2 do Audi A3 40 TFSI e (150 kg payload -> 0.47 / 0.48 / 0.52 G)', () => {
    const limits = computeDynamicKammLimits(audiA3Base, 'road');

    expect(limits.latLimit).toBeCloseTo(0.47, 2);
    expect(limits.accelLimit).toBeCloseTo(0.48, 2);
    expect(limits.brakeLimit).toBeCloseTo(0.52, 2);
    expect(limits.brakeLimit).toBeGreaterThanOrEqual(limits.accelLimit);
  });

  it('reproduz sensibilidade à carga (payload 75 kg -> 0.47 / 0.49 / 0.53 G como em session 175207)', () => {
    const solo = { ...audiA3Base, payloadKg: 75, grossMassKg: 1710 };
    const limits = computeDynamicKammLimits(solo, 'road');

    expect(limits.latLimit).toBeCloseTo(0.47, 2);
    expect(limits.accelLimit).toBeCloseTo(0.49, 2);
    expect(limits.brakeLimit).toBeCloseTo(0.53, 2);
  });

  it('expande limites em modo competition respeitando sempre gripLimitG e brakeLimit >= accelLimit', () => {
    const road = computeDynamicKammLimits(audiA3Base, 'road');
    const comp = computeDynamicKammLimits(audiA3Base, 'competition');

    expect(comp.latLimit).toBeGreaterThan(road.latLimit);
    expect(comp.brakeLimit).toBeGreaterThanOrEqual(comp.accelLimit);
    expect(comp.latLimit).toBeLessThanOrEqual(comp.gripLimitG);
    expect(comp.brakeLimit).toBeLessThanOrEqual(comp.gripLimitG);
  });

  it('BUG FIX baixa aderência: em gelo (surfaceGrip = 0.25) NENHUM limite excede gripLimitG', () => {
    const iceCar = { ...audiA3Base, surfaceGrip: 0.25 };
    const limits = computeDynamicKammLimits(iceCar, 'road');

    expect(limits.gripLimitG).toBeCloseTo(0.25, 4);
    expect(limits.accelLimit).toBeLessThanOrEqual(0.25);
    expect(limits.brakeLimit).toBeLessThanOrEqual(0.25);
    expect(limits.latLimit).toBeLessThanOrEqual(0.25);
    expect(limits.brakeLimit).toBeGreaterThanOrEqual(limits.accelLimit);
  });
});

describe('kamm — computeKammIndex (elipse assimétrica Bloco D)', () => {
  const limits = { accelLimit: 0.4, brakeLimit: 0.6, latLimit: 0.5, gripLimitG: 0.95 };

  it('usa accelLimit para axG >= 0 e brakeLimit para axG < 0', () => {
    // No limite exato de aceleração (+0.4 G)
    expect(computeKammIndex(0.4, 0, limits)).toBeCloseTo(1.0, 6);
    // No limite exato de travagem (-0.6 G)
    expect(computeKammIndex(-0.6, 0, limits)).toBeCloseTo(1.0, 6);
    // No limite exato lateral (±0.5 G)
    expect(computeKammIndex(0, 0.5, limits)).toBeCloseTo(1.0, 6);
    expect(computeKammIndex(0, -0.5, limits)).toBeCloseTo(1.0, 6);
    // Combinado: 0.3 / 0.6 = 0.5 em travagem e 0.4 / 0.5 = 0.8 lateral => hypot(0.5, 0.8) ≈ 0.9434
    expect(computeKammIndex(-0.3, 0.4, limits)).toBeCloseTo(Math.hypot(0.5, 0.8), 5);
  });
});
