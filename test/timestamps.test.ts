/**
 * Issue #20 — Fase 1.5b: Motor Temporal (src/core/timestamps.ts)
 * Destino em telemetry-sim: test/timestamps.test.ts
 *
 * Contrato travado por este teste:
 *   - parseTimestampMs(ts: string | number | null | undefined): number
 *       Suporta: (a) epoch ms (>= 1e12 ou string 10-16 dígitos), (b) ISO-8601
 *       ("YYYY-MM-DD HH:MM:SS.sss" ou com "T"), (c) segundos relativos (0.0, 0.2, ...).
 *       Retorna NaN para entradas inválidas/vazias.
 *   - computeSampleTiming(timestampsMs: readonly number[], defaultDtSec?: number): SampleTiming[]
 *       Devolve { elapsedSec, dtSec, isGap } para cada amostra.
 *       Lacunas com rawDt > 1.0 s marcam isGap = true e usam defaultDtSec (0.20 s) em dtSec.
 */
import { describe, expect, it } from 'vitest';
import { computeSampleTiming, parseTimestampMs } from '../src/core/timestamps.ts';

describe('timestamps — parseTimestampMs', () => {
  it('faz parse de epoch em milissegundos (número e string)', () => {
    expect(parseTimestampMs(1794936091800)).toBe(1794936091800);
    expect(parseTimestampMs('1794936091800')).toBe(1794936091800);
    // Epoch em segundos (10 dígitos) deve ser convertido para ms
    expect(parseTimestampMs('1794936091')).toBe(1794936091000);
  });

  it('faz parse de ISO-8601 com espaço e milissegundos (formato generate_trip_debrief.js)', () => {
    const t0 = parseTimestampMs('2026-11-17 17:21:31.800');
    const t1 = parseTimestampMs('2026-11-17 17:21:32.000');
    const t2 = parseTimestampMs('2026-11-17T17:21:32.200');

    expect(Number.isFinite(t0)).toBe(true);
    expect(t1 - t0).toBe(200);
    expect(t2 - t1).toBe(200);
  });

  it('suporta timestamps numéricos relativos em segundos para fixtures sintéticas (0.0, 0.2, 0.4)', () => {
    const t0 = parseTimestampMs(0.0);
    const t1 = parseTimestampMs(0.2);
    const t2 = parseTimestampMs('0.4');

    expect(t0).toBe(0);
    expect(t1 - t0).toBeCloseTo(200, 6);
    expect(t2 - t1).toBeCloseTo(200, 6);
  });

  it('retorna NaN para strings vazias, inválidas ou formato legado descontinuado', () => {
    expect(Number.isNaN(parseTimestampMs(''))).toBe(true);
    expect(Number.isNaN(parseTimestampMs('invalid'))).toBe(true);
    expect(Number.isNaN(parseTimestampMs('18:32:03 07/11/26'))).toBe(true);
    expect(Number.isNaN(parseTimestampMs(null))).toBe(true);
    expect(Number.isNaN(parseTimestampMs(undefined))).toBe(true);
  });
});

describe('timestamps — computeSampleTiming (dt & isGap)', () => {
  it('calcula elapsedSec e dtSec=0.20 s a 5 Hz sem marcar gaps', () => {
    const base = 1794936091800;
    const timing = computeSampleTiming([base, base + 200, base + 400, base + 600]);

    expect(timing).toHaveLength(4);
    expect(timing[0]).toEqual({ elapsedSec: 0, dtSec: 0.2, isGap: false });
    expect(timing[1]?.elapsedSec).toBeCloseTo(0.2, 6);
    expect(timing[1]?.dtSec).toBeCloseTo(0.2, 6);
    expect(timing[1]?.isGap).toBe(false);
    expect(timing[3]?.elapsedSec).toBeCloseTo(0.6, 6);
  });

  it('sinaliza isGap=true quando rawDt > 1.0 s sem corromper dtSec nem elapsedSec', () => {
    const base = 1794936091800;
    const timing = computeSampleTiming([
      base,
      base + 200,
      base + 2700, // lacuna de 2.5 s (> 1.0 s)
      base + 2900,
    ]);

    expect(timing[1]?.isGap).toBe(false);
    expect(timing[2]?.isGap).toBe(true);
    expect(timing[2]?.dtSec).toBeCloseTo(0.2, 6);
    expect(timing[2]?.elapsedSec).toBeCloseTo(2.7, 6);
    expect(timing[3]?.isGap).toBe(false);
    expect(timing[3]?.dtSec).toBeCloseTo(0.2, 6);
  });

  it('usa fallback 0.20 s quando timestamps são NaN', () => {
    const timing = computeSampleTiming([Number.NaN, Number.NaN, Number.NaN]);

    expect(timing[0]?.elapsedSec).toBe(0);
    expect(timing[1]?.dtSec).toBeCloseTo(0.2, 6);
    expect(timing[2]?.elapsedSec).toBeCloseTo(0.4, 6);
    expect(timing[2]?.isGap).toBe(false);
  });
});
