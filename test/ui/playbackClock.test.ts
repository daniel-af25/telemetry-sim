/**
 * Issue #12 — Fase 3.1: PlaybackClock Mestre 60 FPS (src/state/playbackClock.ts)
 * Destino em telemetry-sim: test/ui/playbackClock.test.ts
 *
 * Contrato travado por este teste:
 *   - createPlaybackClock(durationSec: number): PlaybackClock
 *       Métodos: play(), pause(), toggle(), seek(tSec), setRate(rate),
 *       step(realDeltaSec), getTimeSec(), getRate(), isPlaying(), onTick(cb) => unsubscribe.
 *       Nota: expor step(realDeltaSec) permite testar avanço determinístico sem depender de timers reais!
 */
import { describe, expect, it, vi } from 'vitest';
import { createPlaybackClock } from '../../src/state/playbackClock.ts';

describe('playbackClock — relógio mestre determinístico (0.25x..4x, seek, clamp)', () => {
  it('avança proporcionalmente à taxa (0.25x, 1x, 4x) apenas quando isPlaying=true', () => {
    const clock = createPlaybackClock(60.0);
    expect(clock.getTimeSec()).toBe(0);
    expect(clock.isPlaying()).toBe(false);

    // Em pausa, step() não avança o tempo
    clock.step(1.0);
    expect(clock.getTimeSec()).toBe(0);

    clock.play();
    clock.setRate(0.25);
    clock.step(2.0); // 2 s reais a 0.25x => +0.5 s de telemetria
    expect(clock.getTimeSec()).toBeCloseTo(0.5, 5);

    clock.setRate(4.0);
    clock.step(1.0); // +4.0 s
    expect(clock.getTimeSec()).toBeCloseTo(4.5, 5);
  });

  it('faz clamp em [0, duration], pausa automaticamente ao chegar ao fim e notifica onTick', () => {
    const clock = createPlaybackClock(10.0);
    const onTick = vi.fn();
    clock.onTick(onTick);

    clock.seek(-5);
    expect(clock.getTimeSec()).toBe(0);

    clock.seek(9.5);
    clock.play();
    clock.step(2.0); // ultrapassa 10.0 s

    expect(clock.getTimeSec()).toBe(10.0);
    expect(clock.isPlaying()).toBe(false);
    expect(onTick).toHaveBeenCalled();
  });
});
