import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parseVehiclesCsv } from '../src/core/vehicleCatalog.ts';

const FIXTURE_PATH = resolve(process.cwd(), 'test/fixtures/vehicles_test.csv');

test('Vehicle Catalog CSV Ingestion Suite', async (t) => {
  const csvContent = readFileSync(FIXTURE_PATH, 'utf-8');
  const catalog = parseVehiclesCsv(csvContent);

  await t.test('deve processar o ficheiro e criar um Map indexado pelo id do veículo', () => {
    assert.ok(catalog instanceof Map, 'O resultado deve ser uma instância de Map');
    assert.strictEqual(catalog.size, 4, 'O catálogo deve conter exatamente 4 veículos');
    assert.ok(catalog.has(1), 'Deve conter o veículo com id 1');
    assert.ok(catalog.has(2), 'Deve conter o veículo com id 2');
    assert.ok(catalog.has(3), 'Deve conter o veículo com id 3');
  });

  await t.test('deve mapear corretamente os campos nominais e os tipos numéricos', () => {
    const golf = catalog.get(1);
    assert.ok(golf !== undefined, 'Veículo 1 deve existir');

    assert.strictEqual(golf.id, 1);
    assert.strictEqual(golf.make, 'Volkswagen');
    assert.strictEqual(golf.model, 'Golf');
    assert.strictEqual(golf.serie, 'GTI');
    assert.strictEqual(golf.weight_kg, 1463);
    assert.strictEqual(golf.power_kw, 180.0);
    assert.strictEqual(golf.drag_cd, 0.31);
    assert.strictEqual(golf.drivetrain, 'FWD');
  });

  await t.test('deve lidar com valores ausentes ou nulos sem falhar e sem gerar NaN', () => {
    const incompleteVehicle = catalog.get(4);
    assert.ok(incompleteVehicle !== undefined, 'Veículo 4 deve ser importado');

    // Campos omitidos devem ser undefined ou nulos, nunca NaN
    assert.strictEqual(incompleteVehicle.make, 'Generic');
    assert.strictEqual(incompleteVehicle.displacement_cc, undefined);
    assert.strictEqual(incompleteVehicle.drag_cd, undefined);
    assert.strictEqual(incompleteVehicle.weight_kg, 1200);
  });

  await t.test('deve retornar um Map vazio ao receber uma string vazia ou apenas cabeçalhos', () => {
    const emptyResult = parseVehiclesCsv('');
    assert.strictEqual(emptyResult.size, 0);

    const headersOnly = 'id,make,model,weight_kg\n';
    const noRowsResult = parseVehiclesCsv(headersOnly);
    assert.strictEqual(noRowsResult.size, 0);
  });
});