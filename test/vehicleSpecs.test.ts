import { describe, expect, it } from 'vitest';
import { resolveVehicleSpecs } from '../src/core/vehicleSpecs';
import type { VehicleCatalogEntry } from '../src/core/vehicleCatalog';

const golfGti: VehicleCatalogEntry = {
  id: 1,
  make: 'Volkswagen',
  model: 'Golf',
  serie: 'GTI',
  body_style: 'Hatchback',
  segment: 'Compact',
  power_hp: 245,
  drivetrain: 'FWD',
  weight_kg: 1463,
  gross_weight_kg: 1930, // GVWR homologado — NÃO deve ser usado como massa em marcha
  tire_size: '225/40 R18',
};

const suvMdx: VehicleCatalogEntry = {
  id: 4,
  make: 'Acura',
  model: 'MDX',
  body_style: 'SUV (Sports Utility Vehicle)',
  segment: 'Medium SUV',
  power_hp: 290,
  drivetrain: 'AWD',
  weight_kg: 1912,
  tire_size: '245/60 R18',
};

const coupeRwd: VehicleCatalogEntry = {
  id: 2,
  make: 'AC',
  model: 'Aceca',
  body_style: 'Coupé (two-door)',
  segment: 'Sport Coupe',
  power_hp: 350,
  drivetrain: 'RWD',
  weight_kg: 1615,
  tire_size: '255/55 R18',
};

describe('resolveVehicleSpecs', () => {
  it('calcula grossMassKg como curb + payload (piloto + passageiro) e ignora GVWR do catálogo', () => {
    const specs = resolveVehicleSpecs(golfGti, {
      pilotWeightKg: 75,
      passengerWeightKg: 75,
    });

    expect(specs.curbMassKg).toBe(1463);
    expect(specs.payloadKg).toBe(150);
    expect(specs.grossMassKg).toBe(1613);
    expect(specs.grossMassKg).not.toBe(1930);
    expect(specs.powerHp).toBe(245);
    expect(specs.name).toBe('Volkswagen Golf');
  });

  it('aplica payload padrão de 75 kg (condutor) quando a sessão não indica pesos', () => {
    const specs = resolveVehicleSpecs(golfGti);

    expect(specs.curbMassKg).toBe(1463);
    expect(specs.payloadKg).toBe(75);
    expect(specs.grossMassKg).toBe(1538);
  });

  it('estima geometria fisicamente coerente para Hatchback FWD, SUV AWD e Coupe RWD', () => {
    const hatch = resolveVehicleSpecs(golfGti);
    const suv = resolveVehicleSpecs(suvMdx);
    const coupe = resolveVehicleSpecs(coupeRwd);

    expect(hatch.geometrySource).toBe('estimated');
    expect(suv.geometrySource).toBe('estimated');
    expect(coupe.geometrySource).toBe('estimated');

    // Altura do CG: Coupe < Hatchback < SUV
    expect(coupe.cgHeight).toBeLessThan(hatch.cgHeight);
    expect(hatch.cgHeight).toBeLessThan(suv.cgHeight);

    // Distribuição de peso dianteira: FWD mais carregado à frente do que Coupe RWD
    expect(hatch.frontWeightRatio).toBeGreaterThan(coupe.frontWeightRatio);

    // Via do SUV >= Hatchback
    expect(suv.trackF).toBeGreaterThanOrEqual(hatch.trackF);
  });

  it('respeita overrides manuais e marca geometrySource como measured', () => {
    const specs = resolveVehicleSpecs(
      golfGti,
      { pilotWeightKg: 80 },
      {
        wheelbaseL: 2.631,
        cgHeight: 0.51,
        surfaceGrip: 0.72,
      },
    );

    expect(specs.wheelbaseL).toBeCloseTo(2.631, 4);
    expect(specs.cgHeight).toBeCloseTo(0.51, 4);
    expect(specs.surfaceGrip).toBeCloseTo(0.72, 4);
    expect(specs.geometrySource).toBe('measured');
  });

  it('fornece fallbacks seguros (sem NaN nem zeros) para um veículo sem dados no catálogo', () => {
    const specs = resolveVehicleSpecs(undefined, {});

    expect(specs.curbMassKg).toBeGreaterThan(400);
    expect(specs.grossMassKg).toBeGreaterThanOrEqual(specs.curbMassKg);
    expect(specs.powerHp).toBeGreaterThan(20);
    expect(specs.wheelbaseL).toBeGreaterThan(1.5);
    expect(specs.trackF).toBeGreaterThan(1.0);
    expect(specs.trackR).toBeGreaterThan(1.0);
    expect(specs.cgHeight).toBeGreaterThan(0.3);
    expect(specs.tireRadiusM).toBeGreaterThan(0.2);
    expect(specs.surfaceGrip).toBeGreaterThan(0);
    expect(Number.isFinite(specs.grossMassKg)).toBe(true);
  });
});