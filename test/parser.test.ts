/**
 * Issue #20 — Fase 1.5b: Parser Multi-Formato (src/core/parser.ts)
 * Destino em telemetry-sim: test/parser.test.ts
 *
 * Contrato travado por este teste:
 *   - parseCsv(csvContent: string): ParseCsvResult
 *       ParseCsvResult = {
 *         profile: 'labsis_v22_export' | 'generic_iso';
 *         metadata: Record<string, string>;
 *         sessionVehicleMeta?: {
 *           sessionId?: string; driver?: string; vehicle?: string;
 *           powerHp?: number; curbWeightKg?: number; pilotWeightKg?: number;
 *           passengerWeightKg?: number; payloadKg?: number; grossMassKg?: number;
 *           limitLatG?: number; limitAccelG?: number; limitBrakeG?: number;
 *         };
 *         scalingFactor: number;
 *         extraChannels: string[];
 *         data: TelemetryPointRaw[]; // com lat/lon: number | null, gpsValid: boolean, timestampMs, elapsedSec, dtSec, isGap
 *       }
 */
import { describe, expect, it } from 'vitest';
import { parseCsv } from '../src/core/parser.ts';

const V22_HEADER =
  'sample_index,timestamp,timestamp_ms,elapsed_s,dt_s,lat,lon,speed_kmh,speed_ms,distance_cum_km,heading_deg,accel_x_raw_g,accel_y_raw_g,accel_z_raw_g,accel_lat_comp_g,accel_lon_comp_g,gyro_x_dps,gyro_y_dps,gyro_z_dps,road_grade_pct,kamm_index,session_id,driver,vehicle,power_hp,curb_weight_kg,pilot_weight_kg,passenger_weight_kg,payload_kg,gross_mass_kg,limit_lat_g,limit_accel_g,limit_brake_g';

describe('parser — perfil labsis_v22_export (novos CSVs 5 Hz)', () => {
  it('auto-deteta labsis_v22_export, respeita RFC 4180 com vírgulas entre aspas e extrai metadados do veículo', () => {
    const csv = [
      V22_HEADER,
      '0,2026-11-17 17:21:31.800,1794936091800,0.000,0.200,41.1720015,-8.5485590,36.00,10.000,0.00000,270.50,0.0700,0.0970,0.9690,-0.0250,0.1200,-0.43,0.06,5.50,1.2,0.2500,TRIP_20261117_172131,Marcel,"AUDI A3 Sportback, 40 TFSI e (204 HP)",204,1635,75,75,150,1785,0.47,0.48,0.52',
      '1,2026-11-17 17:21:32.000,1794936092000,0.200,0.200,41.1720100,-8.5485700,37.80,10.500,0.00200,271.00,0.0680,0.1100,0.9710,-0.0300,0.1350,-0.25,0.07,6.00,1.2,0.2900,TRIP_20261117_172131,Marcel,"AUDI A3 Sportback, 40 TFSI e (204 HP)",204,1635,75,75,150,1785,0.47,0.48,0.52',
    ].join('\n');

    const res = parseCsv(csv);

    expect(res.profile).toBe('labsis_v22_export');
    expect(res.scalingFactor).toBe(1);
    expect(res.data).toHaveLength(2);

    const p0 = res.data[0];
    expect(p0).toBeDefined();
    expect(p0?.speed).toBeCloseTo(36.0, 4);
    expect(p0?.lat).toBeCloseTo(41.1720015, 6);
    expect(p0?.lon).toBeCloseTo(-8.548559, 6);
    expect(p0?.gpsValid).toBe(true);
    expect(p0?.accelX).toBeCloseTo(0.07, 4);
    expect(p0?.accelY).toBeCloseTo(0.097, 4);
    expect(p0?.accelZ).toBeCloseTo(0.969, 4);
    expect(p0?.accelLatCompG).toBeCloseTo(-0.025, 4);
    expect(p0?.accelLonCompG).toBeCloseTo(0.12, 4);
    expect(p0?.gyroZ).toBeCloseTo(5.5, 4);
    expect(p0?.timestampMs).toBe(1794936091800);
    expect(p0?.dtSec).toBeCloseTo(0.2, 4);
    expect(p0?.isGap).toBe(false);

    expect(res.sessionVehicleMeta?.sessionId).toBe('TRIP_20261117_172131');
    expect(res.sessionVehicleMeta?.driver).toBe('Marcel');
    expect(res.sessionVehicleMeta?.vehicle).toBe('AUDI A3 Sportback, 40 TFSI e (204 HP)');
    expect(res.sessionVehicleMeta?.powerHp).toBe(204);
    expect(res.sessionVehicleMeta?.curbWeightKg).toBe(1635);
    expect(res.sessionVehicleMeta?.pilotWeightKg).toBe(75);
    expect(res.sessionVehicleMeta?.passengerWeightKg).toBe(75);
    expect(res.sessionVehicleMeta?.payloadKg).toBe(150);
    expect(res.sessionVehicleMeta?.grossMassKg).toBe(1785);
    expect(res.sessionVehicleMeta?.limitLatG).toBeCloseTo(0.47, 4);
    expect(res.sessionVehicleMeta?.limitAccelG).toBeCloseTo(0.48, 4);
    expect(res.sessionVehicleMeta?.limitBrakeG).toBeCloseTo(0.52, 4);
  });

  it('preserva linhas de túnel quando lat/lon estão vazios ("") ou (0, 0) com gpsValid=false', () => {
    const csv = [
      V22_HEADER,
      '0,2026-11-17 17:21:31.800,1794936091800,0.000,0.200,41.1720,-8.5485,50.0,13.889,0.00,90.0,0.01,0.02,0.99,0.00,0.00,0,0,0.5,0,0.01,S1,D,Car,150,1400,75,0,75,1475,0.47,0.45,0.50',
      '1,2026-11-17 17:21:32.000,1794936092000,0.200,0.200,,,50.0,13.889,0.00,90.0,0.02,0.01,0.98,0.01,-0.01,0,0,1.2,0,0.02,S1,D,Car,150,1400,75,0,75,1475,0.47,0.45,0.50',
      '2,2026-11-17 17:21:32.200,1794936092200,0.400,0.200,0,0,50.0,13.889,0.00,90.0,0.02,0.01,0.98,0.01,-0.01,0,0,1.1,0,0.02,S1,D,Car,150,1400,75,0,75,1475,0.47,0.45,0.50',
    ].join('\n');

    const res = parseCsv(csv);

    expect(res.data).toHaveLength(3);
    expect(res.data[0]?.gpsValid).toBe(true);
    expect(res.data[1]?.gpsValid).toBe(false);
    expect(res.data[1]?.lat).toBeNull();
    expect(res.data[1]?.lon).toBeNull();
    expect(res.data[2]?.gpsValid).toBe(false);
    expect(res.data[2]?.lat).toBeNull();
    expect(res.data[2]?.lon).toBeNull();
  });

  it('deteta lacunas temporais (dt > 1.0 s) em labsis_v22_export', () => {
    const csv = [
      V22_HEADER,
      '0,2026-11-17 17:21:31.800,1794936091800,0.000,0.200,41.1720,-8.5485,40.0,11.111,0.00,90.0,0.0,0.0,1.0,0.0,0.0,0,0,0,0,0,S1,D,Car,150,1400,75,0,75,1475,0.47,0.45,0.50',
      '1,2026-11-17 17:21:35.000,1794936095000,3.200,0.200,41.1725,-8.5485,40.0,11.111,0.04,90.0,0.0,0.0,1.0,0.0,0.0,0,0,0,0,0,S1,D,Car,150,1400,75,0,75,1475,0.47,0.45,0.50',
    ].join('\n');

    const res = parseCsv(csv);
    expect(res.data[0]?.isGap).toBe(false);
    expect(res.data[1]?.isGap).toBe(true);
  });
});

describe('parser — perfil generic_iso, mili-G robusto e extraChannels', () => {
  it('deteta sessão em mili-G via mediana(|accelZ|) > 100 e divide corretamente por 1000', () => {
    const csv = [
      '# trip_mode=road',
      'timestamp,lat,lon,speed,accelX,accelY,accelZ,gyroZ',
      '0.0,41.15,-8.61,40.0,150,200,980,1.2',
      '0.2,41.15,-8.61,40.5,120,180,1010,1.1',
      '0.4,41.15,-8.61,41.0,110,160,995,1.0',
    ].join('\n');

    const res = parseCsv(csv);
    expect(res.profile).toBe('generic_iso');
    expect(res.metadata['trip_mode']).toBe('road');
    expect(res.scalingFactor).toBe(1000);
    expect(res.data[0]?.accelZ).toBeCloseTo(0.98, 4);
  });

  it('NÃO ativa mili-G por causa de um único pico corrupto (999) numa sessão normal em G, e filtra o pico', () => {
    const rows = [
      'timestamp,lat,lon,speed,accelX,accelY,accelZ,gyroZ',
      // 20 linhas normais em G
      ...Array.from({ length: 20 }, (_, i) => `${(i * 0.2).toFixed(1)},41.15,-8.61,50.0,0.1,-0.2,0.99,2.0`),
      // 1 único pico corrompido
      '4.2,41.15,-8.61,50.0,999.0,0.0,1.0,0.0',
    ].join('\n');

    const res = parseCsv(rows);
    expect(res.scalingFactor).toBe(1);
    // A linha corrupta (|accelX| > 25 G) é descartada pelo spike filter
    expect(res.data).toHaveLength(20);
    expect(res.data[0]?.accelY).toBeCloseTo(-0.2, 4);
  });

  it('auto-descobre canais extras numéricos e ignora strings não numéricas em extras', () => {
    const csv = [
      'timestamp,lat,lon,speed,accelX,accelY,accelZ,gyroZ,boost_bar,brake_temp,note',
      '0.0,41.15,-8.61,40.0,0.1,0.2,1.0,0.0,1.4,320,ok',
    ].join('\n');

    const res = parseCsv(csv);
    expect(res.extraChannels).toContain('boost_bar');
    expect(res.extraChannels).toContain('brake_temp');
    expect(res.extraChannels).not.toContain('note');
    expect(res.data[0]?.extras?.['boost_bar']).toBeCloseTo(1.4, 4);
    expect(res.data[0]?.extras?.['brake_temp']).toBeCloseTo(320, 4);
  });
});
