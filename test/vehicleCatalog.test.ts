import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseVehiclesCsv } from '../src/core/vehicleCatalog.ts';

const FIXTURE_PATH = resolve(process.cwd(), 'test/fixtures/vehicles_test.csv');

describe('Vehicle Catalog CSV Ingestion Suite', () => {
  const csvContent = readFileSync(FIXTURE_PATH, 'utf-8');
  const catalog = parseVehiclesCsv(csvContent);

  it('deve processar o ficheiro e criar um Map indexado pelo id do veículo', () => {
    expect(catalog).toBeInstanceOf(Map);
    expect(catalog.size).toBe(4);
    expect(catalog.has(1)).toBe(true);
    expect(catalog.has(2)).toBe(true);
    expect(catalog.has(3)).toBe(true);
  });

  it('deve mapear corretamente os campos nominais e os tipos numéricos', () => {
    const golf = catalog.get(1);
    expect(golf).toBeDefined();

    expect(golf?.id).toBe(1);
    expect(golf?.make).toBe('Volkswagen');
    expect(golf?.model).toBe('Golf');
    expect(golf?.serie).toBe('GTI');
    expect(golf?.weight_kg).toBe(1463);
    expect(golf?.power_kw).toBe(180.0);
    expect(golf?.drag_cd).toBe(0.31);
    expect(golf?.drivetrain).toBe('FWD');
  });

  it('deve lidar com valores ausentes ou nulos sem falhar e sem gerar NaN', () => {
    const incompleteVehicle = catalog.get(4);
    expect(incompleteVehicle).toBeDefined();

    // Campos omitidos devem ser undefined ou nulos, nunca NaN
    expect(incompleteVehicle?.make).toBe('Generic');
    expect(incompleteVehicle?.displacement_cc).toBeUndefined();
    expect(incompleteVehicle?.drag_cd).toBeUndefined();
    expect(incompleteVehicle?.weight_kg).toBe(1200);
  });

  it('deve retornar um Map vazio ao receber uma string vazia ou apenas cabeçalhos', () => {
    const emptyResult = parseVehiclesCsv('');
    expect(emptyResult.size).toBe(0);

    const headersOnly = 'id,make,model,weight_kg\n';
    const noRowsResult = parseVehiclesCsv(headersOnly);
    expect(noRowsResult.size).toBe(0);
  });
});
