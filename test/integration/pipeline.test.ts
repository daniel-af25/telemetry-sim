/**
 * Issue #8 — Fase 1.5f: Pipeline Headless Integrado & Regressão (src/core/pipeline.ts)
 * Destino em telemetry-sim: test/integration/pipeline.test.ts
 *
 * Contrato travado por este teste:
 *   - runTelemetryPipeline(csvContent: string, options?: PipelineOptions): TelemetryPipelineResult
 *       Orquestra: parseCsv -> resolveVehicleSpecs -> calibrateSamples ->
 *       computeDynamicKammLimits -> computeLoadTransfer -> detectIncidents ->
 *       computeDrivingSkillPillars -> summary.
 */
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runTelemetryPipeline } from '../../src/core/pipeline.ts';
import type { VehicleCatalogEntry } from '../../src/core/vehicleCatalog.ts';

const V22_HEADER =
  'sample_index,timestamp,timestamp_ms,elapsed_s,dt_s,lat,lon,speed_kmh,speed_ms,distance_cum_km,heading_deg,accel_x_raw_g,accel_y_raw_g,accel_z_raw_g,accel_lat_comp_g,accel_lon_comp_g,gyro_x_dps,gyro_y_dps,gyro_z_dps,road_grade_pct,kamm_index,session_id,driver,vehicle,power_hp,curb_weight_kg,pilot_weight_kg,passenger_weight_kg,payload_kg,gross_mass_kg,limit_lat_g,limit_accel_g,limit_brake_g';

function buildSyntheticV22Csv(sampleCount: number): string {
  const rows = [V22_HEADER];
  const baseMs = 1794936091800;

  for (let i = 0; i < sampleCount; i++) {
    const ms = baseMs + i * 200;
    const elapsed = (i * 0.2).toFixed(3);
    const speedKmh = i < 25 ? 0 : 45.0; // 5 s parado para tara + condução normal a 45 km/h
    const speedMs = speedKmh / 3.6;
    const lat = (41.172 + i * 0.00002).toFixed(7);
    const lon = (-8.548 - i * 0.00001).toFixed(7);
    const distKm = ((Math.max(0, i - 25) * 0.2 * 12.5) / 1000).toFixed(5);
    // Curva suave à esquerda entre amostras 60..75: +0.20 G ISO => LABSIS accel_lat_comp = -0.20
    const inCurve = i >= 60 && i < 75;
    const latComp = inCurve ? -0.2 : 0.0;
    const gzDps = inCurve ? ((0.2 * 9.80665) / 12.5) * (180 / Math.PI) : 0.0;
    const rawX = (0.07 + latComp).toFixed(4);
    const rawY = (0.095).toFixed(4);

    rows.push(
      [
        i,
        `2026-11-17 17:21:${String(31 + Math.floor(i / 5)).padStart(2, '0')}.${(i % 5) * 200}`,
        ms,
        elapsed,
        '0.200',
        lat,
        lon,
        speedKmh.toFixed(2),
        speedMs.toFixed(3),
        distKm,
        '295.00',
        rawX,
        rawY,
        '0.9800',
        latComp.toFixed(4),
        '0.0000',
        '0.00',
        '0.00',
        gzDps.toFixed(2),
        '0.0',
        '0.1000',
        'TRIP_TEST_5HZ',
        'Daniel',
        '"AUDI A3 Sportback 40 TFSI e"',
        204,
        1635,
        75,
        75,
        150,
        1785,
        '0.47',
        '0.48',
        '0.52',
      ].join(','),
    );
  }
  return rows.join('\n');
}

describe('integration — runTelemetryPipeline (v2.2 5 Hz ponta a ponta)', () => {
  it('processa viagem válida (>= 1500 amostras e >= 120 s), conserva massa e não gera falsos slip', () => {
    const csv = buildSyntheticV22Csv(1550); // 310 s totais, 305 s em movimento
    const result = runTelemetryPipeline(csv, {
      tripMode: 'road',
      calibrationMode: 'recalibrate_raw',
    });

    expect(result.profile).toBe('labsis_v22_export');
    expect(result.samplesIso).toHaveLength(1550);
    expect(result.loadTransfers).toHaveLength(1550);
    expect(result.summary.isSufficientData).toBe(true);
    expect(result.summary.maxMassConservationErrorN).toBeLessThan(1e-3);

    // Condução normal sem derrapagem => zero incidentes de slip
    const slipIncidents = result.incidents.filter((inc) => inc.category === 'slip');
    expect(slipIncidents).toHaveLength(0);

    // 5 Pilares calculados com score máximo numa condução limpa
    expect(result.pillars).toHaveLength(5);
    expect(result.summary.finalScore).toBeGreaterThanOrEqual(95);
  });

  it('marca isSufficientData=false quando a viagem tem < 1500 amostras', () => {
    const csv = buildSyntheticV22Csv(100); // apenas 20 s
    const result = runTelemetryPipeline(csv, { tripMode: 'road' });

    expect(result.summary.isSufficientData).toBe(false);
    expect(result.summary.finalScore).toBe(0);
  });

  it('preserva linhas de túnel 5 Hz (lat/lon vazios ou 0,0) com gpsValid=false sem NaN ao longo do pipeline', () => {
    const rows = [
      V22_HEADER,
      '0,2026-11-17 17:21:31.800,1794936091800,0.000,0.200,41.1720,-8.5485,50.0,13.889,0.00,90.0,0.01,0.02,0.99,0.00,0.00,0,0,0.5,0,0.01,S1,D,Car,150,1400,75,0,75,1475,0.47,0.45,0.50',
      '1,2026-11-17 17:21:32.000,1794936092000,0.200,0.200,,,50.0,13.889,0.00,90.0,0.02,0.01,0.98,0.01,-0.01,0,0,1.2,0,0.02,S1,D,Car,150,1400,75,0,75,1475,0.47,0.45,0.50',
      '2,2026-11-17 17:21:32.200,1794936092200,0.400,0.200,0,0,50.0,13.889,0.00,90.0,0.02,0.01,0.98,0.01,-0.01,0,0,1.1,0,0.02,S1,D,Car,150,1400,75,0,75,1475,0.47,0.45,0.50',
    ].join('\n');

    const result = runTelemetryPipeline(rows, { tripMode: 'road' });
    expect(result.samplesIso).toHaveLength(3);
    expect(result.samplesIso[1]?.gpsValid).toBe(false);
    expect(result.samplesIso[1]?.lat).toBeNull();
    expect(result.samplesIso[2]?.gpsValid).toBe(false);
    expect(result.samplesIso[2]?.lon).toBeNull();

    for (const lt of result.loadTransfers) {
      expect(Number.isFinite(lt.fzFL)).toBe(true);
      expect(Number.isFinite(lt.steerRad)).toBe(true);
      expect(Number.isFinite(lt.yawMoment)).toBe(true);
    }
    expect(result.summary.maxMassConservationErrorN).toBeLessThan(1e-3);
  });

  it('regressão 5 Hz real: session_TRIP_20261117_172131 (Audi A3 40 TFSI e, 150 kg payload)', () => {
    const csvPath = resolve(
      process.cwd(),
      'tmp/session_TRIP_20261117_172131_telemetry.csv',
    );
    if (!existsSync(csvPath)) return;

    const audiCatalog: Partial<VehicleCatalogEntry> = {
      id: 25374,
      make: 'AUDI',
      model: 'A3 Sportback 40 TFSI e',
      weight_kg: 1635,
      power_hp: 204,
      torque_nm: 350,
      accel_0_100_s: 7.6,
      drivetrain: 'FWD',
      segment: 'Compact',
      body_style: 'Hatchback',
    };

    const result = runTelemetryPipeline(readFileSync(csvPath, 'utf-8'), {
      tripMode: 'road',
      calibrationMode: 'use_csv_compensated',
      catalogEntry: audiCatalog,
    });

    expect(result.profile).toBe('labsis_v22_export');
    expect(result.kammLimits.latLimit).toBeCloseTo(0.47, 2);
    expect(result.kammLimits.accelLimit).toBeCloseTo(0.48, 2);
    expect(result.kammLimits.brakeLimit).toBeCloseTo(0.52, 2);
    expect(result.summary.maxMassConservationErrorN).toBeLessThan(1e-3);
    expect(result.summary.isSufficientData).toBe(true);
    expect(result.pillars).toHaveLength(5);
  });

  it('regressão anti-rampa 5 Hz: session_TRIP_20261117_175207 em recalibrate_raw elimina travagem fantasma no arranque', () => {
    const csvPath = resolve(
      process.cwd(),
      'tmp/session_TRIP_20261117_175207_telemetry.csv',
    );
    if (!existsSync(csvPath)) return;

    const result = runTelemetryPipeline(readFileSync(csvPath, 'utf-8'), {
      tripMode: 'road',
      calibrationMode: 'recalibrate_raw',
    });

    expect(result.calibrationStats.method).toBe('moving_median_tare');
    expect(result.summary.maxMassConservationErrorN).toBeLessThan(1e-3);
    // Elimina a travagem fantasma de -0.128 G no arranque em movimento
    const startAxG = (result.samplesIso[0]?.ax ?? -99) / 9.80665;
    expect(startAxG).toBeGreaterThan(-0.10);
  });
});
