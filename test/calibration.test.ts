/**
 * Issue #21 — Fase 1.5c: Calibração MPU6050 Anti-Rampa & Fronteira LABSIS -> ISO 8855
 * Destino em telemetry-sim: test/calibration.test.ts
 *
 * Contrato travado por este teste:
 *   - calibrateSamples(
 *       rawPoints: readonly TelemetryPointRaw[],
 *       options?: {
 *         profile?: 'labsis_v22_export' | 'generic_iso';
 *         mode?: 'auto' | 'use_csv_compensated' | 'recalibrate_raw';
 *       }
 *     ): CalibrationResult
 *
 *   CalibrationResult = {
 *     samples: CalibratedSampleIso[]; // ax, ay, az em m/s² (ISO 8855), omegaZ em rad/s, speedMs em m/s, roadGradePct
 *     stats: {
 *       method: 'stationary_tare' | 'moving_median_tare' | 'csv_compensated' | 'passthrough_iso';
 *       tareCount: number;
 *       biasRollX: number;
 *       initialPitchBiasY: number;
 *       biasGyroZ: number;
 *       warning?: string;
 *     };
 *   }
 *
 * Convenção ISO 8855 travada:
 *   +ax: aceleração frontal (+compensatedLonG * g)
 *   -ax: travagem
 *   +ay: curva à esquerda (-compensatedLatG * g)
 *   -ay: curva à direita
 *   +omegaZ: guinada anti-horária (esquerda) em rad/s
 */
import { describe, expect, it } from 'vitest';
import { calibrateSamples } from '../src/core/calibration.ts';
import type { TelemetryPointRaw } from '../src/core/types.ts';

const G = 9.80665;

function makePoint(overrides: Partial<TelemetryPointRaw> & { i: number }): TelemetryPointRaw {
  const { i, ...rest } = overrides;
  return {
    timestamp: i * 0.2,
    timestampMs: 1794936091800 + i * 200,
    elapsedSec: i * 0.2,
    dtSec: 0.2,
    isGap: false,
    lat: 41.17 + i * 0.00001,
    lon: -8.55,
    gpsValid: true,
    speed: 0,
    accelX: 0,
    accelY: 0,
    accelZ: 1.0,
    gyroX: 0,
    gyroY: 0,
    gyroZ: 0,
    ...rest,
  };
}

describe('calibration — tara estacionária & mapeamento LABSIS -> ISO 8855', () => {
  it('remove tilt estático do MPU6050 em breadboard e mapeia sinais LABSIS -> ISO 8855 corretamente', () => {
    const biasX = 0.07; // tilt lateral breadboard
    const biasY = 0.095; // tilt longitudinal breadboard
    const biasGz = -0.45; // °/s bias gyroZ

    const points: TelemetryPointRaw[] = [];
    // 25 amostras paradas (5 s iniciais)
    for (let i = 0; i < 25; i++) {
      points.push(
        makePoint({
          i,
          speed: 0,
          accelX: biasX,
          accelY: biasY,
          accelZ: 0.99,
          gyroZ: biasGz,
        }),
      );
    }

    // Amostra 25: curva à esquerda (+0.40 G ISO => LABSIS accelX = biasX - 0.40) + aceleração frontal (+0.30 G)
    points.push(
      makePoint({
        i: 25,
        speed: 54.0, // 15 m/s
        accelX: biasX - 0.4,
        accelY: biasY + 0.3,
        accelZ: 0.99,
        gyroZ: biasGz + 15.0, // +15 °/s anti-horário (esquerda)
      }),
    );

    // Amostra 26: curva à direita (-0.35 G ISO => LABSIS accelX = biasX + 0.35) + travagem (-0.50 G)
    points.push(
      makePoint({
        i: 26,
        speed: 45.0,
        accelX: biasX + 0.35,
        accelY: biasY - 0.5,
        accelZ: 0.99,
        gyroZ: biasGz - 12.0, // -12 °/s horário (direita)
      }),
    );

    const res = calibrateSamples(points, { profile: 'labsis_v22_export', mode: 'recalibrate_raw' });

    expect(res.stats.method).toBe('stationary_tare');
    expect(res.stats.tareCount).toBeGreaterThanOrEqual(10);
    expect(res.stats.biasRollX).toBeCloseTo(biasX, 3);
    expect(res.stats.initialPitchBiasY).toBeCloseTo(biasY, 3);
    expect(res.stats.biasGyroZ).toBeCloseTo(biasGz, 3);

    // Amostra 25: curva à esquerda (+ay) e aceleração (+ax)
    const leftTurn = res.samples[25];
    expect(leftTurn).toBeDefined();
    expect(leftTurn?.ax).toBeCloseTo(0.3 * G, 1);
    expect(leftTurn?.ay).toBeCloseTo(0.4 * G, 1);
    expect(leftTurn?.omegaZ).toBeCloseTo((15.0 * Math.PI) / 180, 3);

    // Amostra 26: curva à direita (-ay) e travagem (-ax)
    const rightTurn = res.samples[26];
    expect(rightTurn).toBeDefined();
    expect(rightTurn?.ax).toBeCloseTo(-0.5 * G, 1);
    expect(rightTurn?.ay).toBeCloseTo(-0.35 * G, 1);
    expect(rightTurn?.omegaZ).toBeCloseTo((-12.0 * Math.PI) / 180, 3);
  });

  it('ANTI-RAMPA (regressão 175207): viagem que começa em movimento e pára depois numa subida de 10% NÃO envenena a tara inicial', () => {
    const trueMountingPitchBias = 0.06; // +0.06 G de montagem real
    const points: TelemetryPointRaw[] = [];

    // 0..49 (10 s): carro começa já a 36 km/h (10 m/s) em plano e em linha reta
    for (let i = 0; i < 50; i++) {
      points.push(
        makePoint({
          i,
          speed: 36.0,
          accelX: 0.04,
          accelY: trueMountingPitchBias, // velocidade constante em plano => accelY == bias montagem
          accelZ: 0.99,
          gyroZ: 0,
        }),
      );
    }

    // 50..89 (8 s): carro pára num semáforo numa rampa de +10% (+0.10 G de gravidade extra em accelY!)
    for (let i = 50; i < 90; i++) {
      points.push(
        makePoint({
          i,
          speed: 0.0,
          accelX: 0.04,
          accelY: trueMountingPitchBias + 0.1, // 0.16 G total na rampa
          accelZ: 0.985,
          gyroZ: 0,
        }),
      );
    }

    const res = calibrateSamples(points, { profile: 'labsis_v22_export', mode: 'recalibrate_raw' });

    // Não pode ter usado a paragem tardia na subida (0.16 G) como plano!
    expect(res.stats.method).toBe('moving_median_tare');
    expect(Math.abs(res.stats.initialPitchBiasY - trueMountingPitchBias)).toBeLessThan(0.02);

    // No arranque em plano a velocidade constante, ax_ISO deve estar próximo de 0 (nunca -0.10 G fantasma!)
    const startSample = res.samples[5];
    expect(startSample).toBeDefined();
    expect(Math.abs((startSample?.ax ?? 99) / G)).toBeLessThan(0.03);
  });

  it('salta atualização do filtro de road-grade em lacunas temporais (isGap=true) sem NaN', () => {
    const points: TelemetryPointRaw[] = [
      makePoint({ i: 0, speed: 50, accelY: 0.05, isGap: false }),
      makePoint({ i: 1, speed: 50, accelY: 0.05, isGap: false }),
      makePoint({ i: 2, speed: 90, accelY: 0.05, isGap: true }), // salto de velocidade numa lacuna!
      makePoint({ i: 3, speed: 90, accelY: 0.05, isGap: false }),
    ];

    const res = calibrateSamples(points, { profile: 'labsis_v22_export', mode: 'recalibrate_raw' });
    for (const s of res.samples) {
      expect(Number.isFinite(s.ax)).toBe(true);
      expect(Number.isFinite(s.roadGradePct)).toBe(true);
    }
    // O salto de velocidade através de isGap não pode criar um declive absurdo
    expect(Math.abs(res.samples[2]?.roadGradePct ?? 99)).toBeLessThan(5.0);
  });

  it('respeita o modo use_csv_compensated aplicando apenas a inversão lateral ISO 8855', () => {
    const points: TelemetryPointRaw[] = [
      makePoint({
        i: 0,
        speed: 40,
        accelLatCompG: -0.25, // curva à esquerda em LABSIS
        accelLonCompG: 0.18, // aceleração em LABSIS
        gyroZ: 10.0,
      }),
    ];

    const res = calibrateSamples(points, { profile: 'labsis_v22_export', mode: 'use_csv_compensated' });
    expect(res.stats.method).toBe('csv_compensated');
    expect(res.samples[0]?.ax).toBeCloseTo(0.18 * G, 3);
    expect(res.samples[0]?.ay).toBeCloseTo(0.25 * G, 3);
    expect(res.samples[0]?.omegaZ).toBeCloseTo((10.0 * Math.PI) / 180, 4);
  });
});
