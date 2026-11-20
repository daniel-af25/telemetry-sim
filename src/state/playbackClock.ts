/**
 * Relógio mestre de reprodução 60 FPS (`createPlaybackClock`):
 * único loop `requestAnimationFrame` da aplicação com controlo de play/pause/toggle/seek,
 * taxas `0.25x..4x`, clamp em `[0, duration]`, `step(realDeltaSec)` determinístico para testes,
 * e amostragem única por frame (`interpolator.sampleAt(t, sharedFrame)`) sem alocações.
 *
 * Testes:
 *   npx vitest run test/ui/playbackClock.test.ts
 */
import type { SampleFrame, TelemetryInterpolator } from '../core/interpolator.ts';

export type PlaybackRate = 0.25 | 0.5 | 1 | 2 | 4;

export type PlaybackTickListener = (
  timeSec: number,
  frame: SampleFrame | null,
) => void;

export interface PlaybackClock {
  play(): void;
  pause(): void;
  toggle(): void;
  seek(tSec: number): void;
  setRate(rate: PlaybackRate): void;
  setDuration(durationSec: number): void;
  setInterpolator(interpolator: TelemetryInterpolator | null): void;
  step(realDeltaSec: number): void;
  getTimeSec(): number;
  getDurationSec(): number;
  getRate(): PlaybackRate;
  isPlaying(): boolean;
  onTick(cb: PlaybackTickListener): () => void;
  dispose(): void;
}

const MAX_RAF_DELTA_SEC = 0.1;

/**
 * Creates the master playback clock driving MapLibre camera, Three.js, and Canvas HUD
 * from a single `requestAnimationFrame` loop (or deterministic `step()` in tests).
 */
export function createPlaybackClock(
  initialDurationSec: number,
  initialInterpolator: TelemetryInterpolator | null = null,
): PlaybackClock {
  let durationSec = Math.max(0, Number.isFinite(initialDurationSec) ? initialDurationSec : 0);
  let interpolator: TelemetryInterpolator | null = initialInterpolator;
  let timeSec = 0;
  let rate: PlaybackRate = 1;
  let playing = false;
  let rafId: number | null = null;
  let lastRafMs: number | null = null;
  let sharedFrame: SampleFrame | null = null;

  const listeners = new Set<PlaybackTickListener>();

  function clampTime(t: number): number {
    if (!Number.isFinite(t) || t <= 0) return 0;
    if (t >= durationSec) return durationSec;
    return t;
  }

  function sampleCurrent(): SampleFrame | null {
    if (!interpolator) return null;
    sharedFrame = sharedFrame
      ? interpolator.sampleAt(timeSec, sharedFrame)
      : interpolator.sampleAt(timeSec);
    return sharedFrame;
  }

  function emitTick(): void {
    const frame = sampleCurrent();
    for (const cb of listeners) {
      cb(timeSec, frame);
    }
  }

  function cancelRaf(): void {
    if (rafId !== null && typeof globalThis.cancelAnimationFrame === 'function') {
      globalThis.cancelAnimationFrame(rafId);
    }
    rafId = null;
    lastRafMs = null;
  }

  function scheduleRaf(): void {
    if (typeof globalThis.requestAnimationFrame !== 'function') return;
    if (rafId !== null) return;

    const tick = (nowMs: number) => {
      rafId = null;
      if (!playing) return;

      if (lastRafMs !== null) {
        const realDeltaSec = Math.min(MAX_RAF_DELTA_SEC, Math.max(0, (nowMs - lastRafMs) / 1000));
        step(realDeltaSec);
      }
      lastRafMs = nowMs;

      if (playing) {
        rafId = globalThis.requestAnimationFrame(tick);
      }
    };

    rafId = globalThis.requestAnimationFrame(tick);
  }

  function play(): void {
    if (playing) return;
    if (durationSec > 0 && timeSec >= durationSec) {
      timeSec = 0;
    }
    playing = true;
    lastRafMs = null;
    scheduleRaf();
  }

  function pause(): void {
    if (!playing) return;
    playing = false;
    cancelRaf();
  }

  function toggle(): void {
    if (playing) pause();
    else play();
  }

  function seek(tSec: number): void {
    timeSec = clampTime(tSec);
    emitTick();
  }

  function setRate(nextRate: PlaybackRate): void {
    rate = nextRate;
  }

  function setDuration(nextDurationSec: number): void {
    durationSec = Math.max(0, Number.isFinite(nextDurationSec) ? nextDurationSec : 0);
    timeSec = clampTime(timeSec);
  }

  function setInterpolator(nextInterpolator: TelemetryInterpolator | null): void {
    interpolator = nextInterpolator;
    if (nextInterpolator) {
      durationSec = Math.max(0, nextInterpolator.durationSec);
      timeSec = clampTime(timeSec);
    }
  }

  function step(realDeltaSec: number): void {
    if (!playing) return;
    if (!Number.isFinite(realDeltaSec) || realDeltaSec <= 0) return;

    const nextTime = timeSec + realDeltaSec * rate;
    if (nextTime >= durationSec) {
      timeSec = durationSec;
      playing = false;
      cancelRaf();
    } else {
      timeSec = Math.max(0, nextTime);
    }
    emitTick();
  }

  function onTick(cb: PlaybackTickListener): () => void {
    listeners.add(cb);
    return () => {
      listeners.delete(cb);
    };
  }

  function dispose(): void {
    pause();
    listeners.clear();
  }

  return {
    play,
    pause,
    toggle,
    seek,
    setRate,
    setDuration,
    setInterpolator,
    step,
    getTimeSec: () => timeSec,
    getDurationSec: () => durationSec,
    getRate: () => rate,
    isPlaying: () => playing,
    onTick,
    dispose,
  };
}
