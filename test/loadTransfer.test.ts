/**
 * Issue #22 — Fase 1.5d: Transferência de Carga, Direção Bloco C & Forças por Roda
 * Destino em telemetry-sim: test/loadTransfer.test.ts
 *
 * Contrato travado por este teste:
 *   - computeLoadTransfer(ax, ay, speed, omegaZ, specs): LoadTransferResult
 *       onde LoadTransferResult inclui:
 *       fzFL, fzFR, fzRL, fzRR (N), steerRad, rollRad, pitchRad,
 *       e forças/momento estimados: fxFL, fxFR, fxRL, fxRR, fyFL, fyFR, fyRL, fyRR (N), yawMoment (N·m)
 *
 * Invariantes ISO 8855 travados:
 *   - Fz_FL + Fz_FR + Fz_RL + Fz_RR == m * g (erro < 1e-3 N) em TODOS os regimes
 *   - Curva à esquerda (+ay): FR > FL e RR > RL; rollRad > 0 (+ lado direito para baixo)
 *   - Curva à direita (-ay): FL > FR e RL > RR; rollRad < 0
 *   - Travagem (-ax): frente > estático; pitchRad > 0 (+ nariz para baixo)
 *   - Bloco C: w_u = clamp((u - 0.3) / 1.2, 0, 1); steerRad = clamp(atan(L * omegaZ * w_u / max(u, 1.0)), -maxSteerRad, +maxSteerRad)
 */
import { describe, expect, it } from 'vitest';
import { computeLoadTransfer } from '../src/core/loadTransfer.ts';
import type { VehicleSpecs } from '../src/core/types.ts';

const G = 9.80665;

const mockCar: VehicleSpecs & { maxSteerRad?: number } = {
  name: 'Test Vehicle',
  grossMassKg: 1500,
  curbMassKg: 1400,
  payloadKg: 100,
  powerHp: 150,
  wheelbaseL: 2.6,
  trackF: 1.55,
  trackR: 1.55,
  cgHeight: 0.54,
  frontWeightRatio: 0.58,
  frontRollShare: 0.58,
  maxSteerRad: 0.6109, // 35°
  tireSize: '205/55 R16',
  tireRadiusM: 0.316,
  surfaceGrip: 0.95,
};

describe('loadTransfer — conservação estrita de massa & sinais ISO 8855', () => {
  it('conserva massa com erro < 1e-3 N em condução combinada, travagem extrema e levantamento de roda', () => {
    const theoreticalWeight = mockCar.grossMassKg * G;
    const cases: Array<[number, number, number, number]> = [
      [-0.5 * G, 0.4 * G, 20, 0.15],
      [0.6 * G, -0.7 * G, 25, -0.2],
      [-2.5 * G, 0, 30, 0], // travagem extrema (eixo traseiro levanta => fzRear == 0)
      [0, 2.5 * G, 20, 0.5], // curva extrema (rodas interiores levantam => splitAxle)
      [3.0 * G, -2.5 * G, 15, -0.4], // aceleração + curva direita extremas
    ];

    for (const [ax, ay, u, wz] of cases) {
      const res = computeLoadTransfer(ax, ay, u, wz, mockCar);
      const totalFz = res.fzFL + res.fzFR + res.fzRL + res.fzRR;
      expect(Math.abs(totalFz - theoreticalWeight)).toBeLessThan(1e-3);
      expect(res.fzFL).toBeGreaterThanOrEqual(0);
      expect(res.fzFR).toBeGreaterThanOrEqual(0);
      expect(res.fzRL).toBeGreaterThanOrEqual(0);
      expect(res.fzRR).toBeGreaterThanOrEqual(0);
    }
  });

  it('carrega rodas direitas (FR/RR) em curva à esquerda (+ay) e esquerdas (FL/RL) em curva à direita (-ay)', () => {
    const left = computeLoadTransfer(0, 0.5 * G, 15, 0.2, mockCar);
    expect(left.fzFR).toBeGreaterThan(left.fzFL);
    expect(left.fzRR).toBeGreaterThan(left.fzRL);
    expect(left.rollRad).toBeGreaterThan(0); // ISO 8855 / view3d.py: +roll = lado direito para baixo

    const right = computeLoadTransfer(0, -0.5 * G, 15, -0.2, mockCar);
    expect(right.fzFL).toBeGreaterThan(right.fzFR);
    expect(right.fzRL).toBeGreaterThan(right.fzRR);
    expect(right.rollRad).toBeLessThan(0);
  });

  it('carrega eixo dianteiro e inclina nariz para baixo (+pitchRad) em travagem (-ax)', () => {
    const staticRes = computeLoadTransfer(0, 0, 10, 0, mockCar);
    const brakeRes = computeLoadTransfer(-0.6 * G, 0, 10, 0, mockCar);

    expect(brakeRes.fzFL + brakeRes.fzFR).toBeGreaterThan(staticRes.fzFL + staticRes.fzFR);
    expect(brakeRes.pitchRad).toBeGreaterThan(0); // ISO 8855 / view3d.py: +pitch = nariz para baixo
  });

  it('aplica splitAxle: quando roda interior levanta (0 N), a roda exterior suporta 100% da carga do eixo', () => {
    const extremeLeft = computeLoadTransfer(0, 2.5 * G, 20, 0.5, mockCar);
    const expectedFront = mockCar.grossMassKg * G * mockCar.frontWeightRatio;

    expect(extremeLeft.fzFL).toBe(0);
    expect(extremeLeft.fzFR).toBeCloseTo(expectedFront, 2);
  });
});

describe('loadTransfer — direção cinemática Bloco C (rampa w_u, max(u,1), clamp ±deltaMax)', () => {
  it('amortece exatamente para 0 rad na zona morta u <= 0.3 m/s (sem NaN)', () => {
    for (const u of [0, 0.1, 0.3]) {
      const res = computeLoadTransfer(0, 0, u, 0.8, mockCar);
      expect(res.steerRad).toBe(0);
      expect(Number.isNaN(res.steerRad)).toBe(false);
    }
  });

  it('aplica rampa linear w_u = (u - 0.3)/1.2 e denominador max(u, 1.0) entre 0.3 e 1.5 m/s', () => {
    const u = 0.9; // w_u = (0.9 - 0.3) / 1.2 = 0.5; max(u, 1.0) = 1.0
    const wz = 0.2;
    const expected = Math.atan((mockCar.wheelbaseL * (wz * 0.5)) / 1.0);
    const res = computeLoadTransfer(0, 0, u, wz, mockCar);

    expect(res.steerRad).toBeCloseTo(expected, 6);
  });

  it('limita steerRad ao intervalo [-maxSteerRad, +maxSteerRad] em guinadas extremas', () => {
    const maxSteer = mockCar.maxSteerRad ?? 0.6109;
    const extremeLeft = computeLoadTransfer(0, 0, 2.0, 5.0, mockCar);
    const extremeRight = computeLoadTransfer(0, 0, 2.0, -5.0, mockCar);

    expect(extremeLeft.steerRad).toBeCloseTo(maxSteer, 5);
    expect(extremeRight.steerRad).toBeCloseTo(-maxSteer, 5);
  });

  it('calcula forças horizontais coerentes (soma Fx == m*ax, soma Fy == m*ay) e yawMoment finito', () => {
    const ax = -0.4 * G;
    const ay = 0.3 * G;
    const res = computeLoadTransfer(ax, ay, 20, 0.15, mockCar);

    const sumFx = res.fxFL + res.fxFR + res.fxRL + res.fxRR;
    const sumFy = res.fyFL + res.fyFR + res.fyRL + res.fyRR;

    expect(sumFx).toBeCloseTo(mockCar.grossMassKg * ax, 1);
    expect(sumFy).toBeCloseTo(mockCar.grossMassKg * ay, 1);
    expect(Number.isFinite(res.yawMoment)).toBe(true);
  });
});
