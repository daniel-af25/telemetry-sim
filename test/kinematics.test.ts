/**
 * Issue #10 — Fase 2.1: Cinemática ENU (WGS84), Filtro Yaw & Túneis (src/core/kinematics.ts)
 * Destino em telemetry-sim: test/kinematics.test.ts
 *
 * Contrato travado por este teste:
 *   - wgs84ToEnu(lat, lon, origin: { lat: number; lon: number }): { x: number; y: number }
 *       +x = East (m), +y = North (m), usando elipsoide WGS84 (R_M, R_N).
 *   - enuToWgs84(x, y, origin: { lat: number; lon: number }): { lat: number; lon: number }
 *   - reconstructKinematics(samples: readonly CalibratedSampleIso[]): KinematicsResult
 *       Devolve { origin, points: KinematicPoint[] } onde cada ponto inclui:
 *       x, y (m), lat, lon (reconstruídos via enuToWgs84 em túneis), yawRad (ISO 8855 CCW a partir de +East),
 *       distM (cumulativa), isTunnelDr: boolean.
 */
import { describe, expect, it } from 'vitest';
import {
  enuToWgs84,
  reconstructKinematics,
  wgs84ToEnu,
} from '../src/core/kinematics.ts';
import type { CalibratedSampleIso } from '../src/core/types.ts';

const ORIGIN = { lat: 41.172, lon: -8.5485 };
const G = 9.80665;

describe('kinematics — projeção elipsoidal WGS84 <-> ENU', () => {
  it('mapeia a origem exatamente para (0, 0) e 1° de latitude a norte ≈ 111.06 km (WGS84 a 41°N)', () => {
    const zero = wgs84ToEnu(ORIGIN.lat, ORIGIN.lon, ORIGIN);
    expect(zero.x).toBeCloseTo(0, 6);
    expect(zero.y).toBeCloseTo(0, 6);

    const oneDegNorth = wgs84ToEnu(ORIGIN.lat + 1.0, ORIGIN.lon, ORIGIN);
    expect(oneDegNorth.x).toBeCloseTo(0, 2);
    // Raio meridional WGS84 a 41°N => ~111,057 m/grau
    expect(oneDegNorth.y).toBeGreaterThan(110800);
    expect(oneDegNorth.y).toBeLessThan(111500);
  });

  it('garante ida-e-volta wgs84ToEnu <-> enuToWgs84 com erro < 1 mm num raio de 10 km', () => {
    const target = { lat: 41.225, lon: -8.48 }; // ~8 km NE
    const enu = wgs84ToEnu(target.lat, target.lon, ORIGIN);
    const back = enuToWgs84(enu.x, enu.y, ORIGIN);
    const enuBack = wgs84ToEnu(back.lat, back.lon, ORIGIN);

    expect(Math.hypot(enuBack.x - enu.x, enuBack.y - enu.y)).toBeLessThan(1e-3);
  });
});

describe('kinematics — filtro complementar de yaw & dead-reckoning em túneis (loop-closure)', () => {
  it('reconstrói trajetória contínua (C0) dentro de um túnel com gpsValid=false e fecha sem salto à saída', () => {
    // Trajeto reto para Este (+x) a 10 m/s (2 m por amostra a 5 Hz) durante 30 amostras (60 m)
    // Amostras 10..19 simulam um túnel de 2 s (20 m sem sinal GPS!)
    const samples: CalibratedSampleIso[] = [];
    for (let i = 0; i < 30; i++) {
      const trueX = i * 2.0;
      const inTunnel = i >= 10 && i < 20;
      const wgs = enuToWgs84(trueX, 0, ORIGIN);

      samples.push({
        sampleIndex: i,
        timestamp: i * 0.2,
        timestampMs: 1794936091800 + i * 200,
        elapsedSec: i * 0.2,
        dtSec: 0.2,
        isGap: false,
        lat: inTunnel ? null : wgs.lat,
        lon: inTunnel ? null : wgs.lon,
        gpsValid: !inTunnel,
        speedMs: 10.0,
        ax: 0,
        ay: 0,
        az: G,
        omegaX: 0,
        omegaY: 0,
        omegaZ: 0.01, // pequena deriva de gyro propositada para testar loop-closure!
        roadGradePct: 0,
      });
    }

    const res = reconstructKinematics(samples);
    expect(res.points).toHaveLength(30);

    // Dentro do túnel deve estar sinalizado isTunnelDr=true e manter coordenadas válidas (nunca NaN nem 0)
    const midTunnel = res.points[15];
    expect(midTunnel?.isTunnelDr).toBe(true);
    expect(Number.isFinite(midTunnel?.x)).toBe(true);
    expect(Number.isFinite(midTunnel?.lat)).toBe(true);
    expect(midTunnel?.x).toBeCloseTo(30.0, 0);

    // Loop-closure: transição túnel -> saída (19 -> 20) sem salto > 3 m (passo normal = 2 m)
    const exitPrev = res.points[19]!;
    const exitFix = res.points[20]!;
    const stepDist = Math.hypot(exitFix.x - exitPrev.x, exitFix.y - exitPrev.y);
    expect(stepDist).toBeLessThan(3.0);
  });

  it('mantém yaw estável sem salto de 360° em curvas perto da transição de quadrante', () => {
    const samples: CalibratedSampleIso[] = [];
    // Movimento para Este (yaw ≈ 0 rad) com pequena oscilação entre -5° e +5°
    let x = 0;
    let y = 0;
    for (let i = 0; i < 20; i++) {
      const heading = ((i % 2 === 0 ? -3 : 3) * Math.PI) / 180;
      x += Math.cos(heading) * 3.0;
      y += Math.sin(heading) * 3.0;
      const wgs = enuToWgs84(x, y, ORIGIN);
      samples.push({
        sampleIndex: i,
        timestamp: i * 0.2,
        timestampMs: 1794936091800 + i * 200,
        elapsedSec: i * 0.2,
        dtSec: 0.2,
        isGap: false,
        lat: wgs.lat,
        lon: wgs.lon,
        gpsValid: true,
        speedMs: 15.0,
        ax: 0,
        ay: 0,
        az: G,
        omegaX: 0,
        omegaY: 0,
        omegaZ: 0,
        roadGradePct: 0,
      });
    }

    const res = reconstructKinematics(samples);
    for (const pt of res.points) {
      // Nunca deve dar a volta por ±π rad
      expect(Math.abs(Math.sin(pt.yawRad))).toBeLessThan(0.25);
    }
  });
});
