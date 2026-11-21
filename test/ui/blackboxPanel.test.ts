/**
 * Issue #15 — Fase 4.3: Black Box Incident Replay 0.25x (src/ui/blackboxPanel.ts)
 * Destino em telemetry-sim: test/ui/blackboxPanel.test.ts
 *
 * Contrato travado por este teste:
 *   - filterIncidents(incidents, filter: { category?: IncidentCategory | 'all'; pillar?: string | 'all' }): Incident[]
 *   - triggerBlackBoxJump(incident: { elapsedSec: number }, clock: PlaybackClock, store: AppStore): void
 *       Salta para Math.max(0, incident.elapsedSec - 3.0), fixa rate = 0.25,
 *       ativa cameraMode = 'chase' e inicia play().
 */
import { describe, expect, it } from 'vitest';
import { createAppStore } from '../../src/state/appStore.ts';
import { createPlaybackClock } from '../../src/state/playbackClock.ts';
import { filterIncidents, triggerBlackBoxJump } from '../../src/ui/blackboxPanel.ts';
import type { Incident } from '../../src/core/types.ts';

const sampleIncidents: Incident[] = [
  {
    category: 'braking',
    points: 7,
    excessRatio: 0.55,
    elapsedSec: 42.5,
    timeStr: '+00:42',
    timestamp: 42.5,
    lat: 41.17,
    lon: -8.55,
    reason: 'Harsh Braking Shock',
    intensity: '0.85 G',
  },
  {
    category: 'slip',
    points: 5,
    excessRatio: 0.6,
    elapsedSec: 1.5,
    timeStr: '+00:01',
    timestamp: 1.5,
    lat: 41.17,
    lon: -8.55,
    reason: 'Kinematic Slip',
    intensity: '32 °/s',
  },
];

describe('blackboxPanel — filtragem & salto Black Box (t - 3.0 s a 0.25x em Chase)', () => {
  it('filtra incidentes por categoria ou por pilar', () => {
    expect(filterIncidents(sampleIncidents, { category: 'all' })).toHaveLength(2);
    expect(filterIncidents(sampleIncidents, { category: 'braking' })).toHaveLength(1);
    expect(filterIncidents(sampleIncidents, { pillar: 'TRACTION CONTROL' })).toHaveLength(1);
  });

  it('executa salto Black Box: t - 3.0 s (clamp a 0), taxa 0.25x, câmara chase e play()', () => {
    const store = createAppStore({ cameraMode: 'free' });
    const clock = createPlaybackClock(120);

    triggerBlackBoxJump(sampleIncidents[0]!, clock, store);
    expect(clock.getTimeSec()).toBeCloseTo(39.5, 4);
    expect(clock.getRate()).toBe(0.25);
    expect(clock.isPlaying()).toBe(true);
    expect(store.getState().cameraMode).toBe('chase');

    // Incidente aos 1.5 s deve fazer clamp a 0.0 s (nunca tempo negativo!)
    triggerBlackBoxJump(sampleIncidents[1]!, clock, store);
    expect(clock.getTimeSec()).toBe(0);
  });
});
