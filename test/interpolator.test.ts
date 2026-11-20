/**
 * Issue #11 — Fase 2.2: Interpolador Contínuo 60+ FPS (src/core/interpolator.ts)
 * Destino em telemetry-sim: test/interpolator.test.ts
 *
 * Contrato travado por este teste:
 *   - interpolateShortestAngle(a1Rad: number, a2Rad: number, alpha: number): number
 *   - createInterpolator(track: TelemetryTrackSoA): {
 *       durationSec: number;
 *       sampleAt(tSec: number, out?: SampleFrame): SampleFrame;
 *     }
 */
import { describe, expect, it } from 'vitest';
import { createInterpolator, interpolateShortestAngle } from '../src/core/interpolator.ts';
import { packToSoA, type ProcessedFrameInput } from '../src/core/soa.ts';

function makeTrack(
  entries: Array<Partial<ProcessedFrameInput> & { t: number; x: number; y: number }>,
) {
  return packToSoA(
    entries.map((e) => ({
      lat: 41.17,
      lon: -8.55,
      speedMs: 10,
      ax: 0,
      ay: 0,
      az: 9.81,
      omegaZ: 0,
      yaw: 0,
      steerRad: 0,
      rollRad: 0,
      pitchRad: 0,
      fzFL: 3600,
      fzFR: 3600,
      fzRL: 3600,
      fzRR: 3600,
      kammIndex: 0,
      roadGradePct: 0,
      distM: 0,
      gpsValid: true,
      isGap: false,
      isTunnelDr: false,
      isSlip: false,
      ...e,
    })),
  );
}

describe('interpolator — interpolateShortestAngle (Bloco F)', () => {
  it('passa pelo caminho curto na transição 359° -> 1° e 1° -> 359° (nunca dá a volta por 180°)', () => {
    const deg = (d: number) => (d * Math.PI) / 180;

    const midFwd = interpolateShortestAngle(deg(359), deg(1), 0.5);
    expect(Math.cos(midFwd)).toBeCloseTo(1.0, 4); // 0° / 360°
    expect(Math.sin(midFwd)).toBeCloseTo(0.0, 4);

    const midRev = interpolateShortestAngle(deg(1), deg(359), 0.5);
    expect(Math.cos(midRev)).toBeCloseTo(1.0, 4);
    expect(Math.sin(midRev)).toBeCloseTo(0.0, 4);
  });

  it('passa pelo caminho curto na transição -179° -> +179° e respeita extremos α=0 e α=1', () => {
    const deg = (d: number) => (d * Math.PI) / 180;

    const midPi = interpolateShortestAngle(deg(-179), deg(179), 0.5);
    expect(Math.cos(midPi)).toBeCloseTo(-1.0, 4); // ±180°

    expect(interpolateShortestAngle(0.4, 1.2, 0)).toBeCloseTo(0.4, 6);
    expect(interpolateShortestAngle(0.4, 1.2, 1)).toBeCloseTo(1.2, 6);
  });
});

describe('interpolator — createInterpolator (Hermite/Fritsch-Carlson sem overshoot & cursor O(1))', () => {
  it('NÃO gera overshoot (recuo artificial) numa travagem até imobilização completa', () => {
    // Carro avança até x=10 m e depois pára em x=10 m
    const track = makeTrack([
      { t: 0.0, x: 0, y: 0, speedMs: 25 },
      { t: 0.2, x: 5, y: 0, speedMs: 20 },
      { t: 0.4, x: 9, y: 0, speedMs: 10 },
      { t: 0.6, x: 10, y: 0, speedMs: 0 },
      { t: 0.8, x: 10, y: 0, speedMs: 0 },
      { t: 1.0, x: 10, y: 0, speedMs: 0 },
    ]);

    const interp = createInterpolator(track);
    for (let t = 0.6; t <= 1.0; t += 0.02) {
      const f = interp.sampleAt(t);
      expect(f.x).toBeLessThanOrEqual(10.001);
      expect(f.x).toBeGreaterThanOrEqual(9.999);
    }
  });

  it('devolve o mesmo resultado via cursor sequencial O(1) e via seek aleatório O(log n), e reutiliza outFrame', () => {
    const track = makeTrack([
      { t: 0.0, x: 0, y: 0, yaw: (355 * Math.PI) / 180 },
      { t: 0.2, x: 2, y: 1, yaw: (359 * Math.PI) / 180 },
      { t: 0.4, x: 4, y: 2, yaw: (3 * Math.PI) / 180 },
      { t: 0.6, x: 6, y: 3, yaw: (7 * Math.PI) / 180 },
    ]);

    const interp = createInterpolator(track);
    const seq = interp.sampleAt(0.3);
    // Salta para o fim e volta a 0.3 para forçar busca binária
    interp.sampleAt(0.6);
    const reused = interp.sampleAt(0.3, seq);

    expect(reused).toBe(seq);
    expect(reused.x).toBeCloseTo(3.0, 2);
    expect(reused.y).toBeCloseTo(1.5, 2);
    // Yaw em t=0.3 entre 359° e 3° deve passar perto de 1° (cos ≈ 1)
    expect(Math.cos(reused.yaw)).toBeGreaterThan(0.99);
  });

  it('faz clamp limpo fora do intervalo [t0, tEnd] sem NaN', () => {
    const track = makeTrack([
      { t: 1.0, x: 5, y: 2 },
      { t: 2.0, x: 15, y: 4 },
    ]);
    const interp = createInterpolator(track);

    expect(interp.sampleAt(-5).x).toBeCloseTo(5, 5);
    expect(interp.sampleAt(99).x).toBeCloseTo(15, 5);
  });
});
