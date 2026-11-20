/**
 * Issue #12 — Fase 3.1: AppStore Tipado Reativo (src/state/appStore.ts)
 * Destino em telemetry-sim: test/ui/appStore.test.ts
 *
 * Contrato travado por este teste:
 *   - createAppStore(initial?: Partial<AppState>): AppStore
 *       Métodos: getState(), setState(partial), subscribe(listener) => unsubscribe
 *       Campos mínimos em AppState: tripMode ('road' | 'competition'), cameraMode ('chase' | 'topdown' | 'free'),
 *       ribbonMetric ('kammIndex' | 'speed' | 'ay' | 'ax' | 'roadGradePct'), surfaceGrip, exaggerate.
 */
import { describe, expect, it, vi } from 'vitest';
import { createAppStore } from '../../src/state/appStore.ts';

describe('appStore — estado frio tipado e pub/sub', () => {
  it('inicializa com defaults seguros e notifica subscritores em setState', () => {
    const store = createAppStore();
    expect(store.getState().tripMode).toBe('road');
    expect(store.getState().cameraMode).toBe('chase');
    expect(store.getState().exaggerate).toBe(4);

    const listener = vi.fn();
    const unsub = store.subscribe(listener);

    store.setState({ cameraMode: 'free', ribbonMetric: 'speed' });
    expect(store.getState().cameraMode).toBe('free');
    expect(store.getState().ribbonMetric).toBe('speed');
    expect(listener).toHaveBeenCalledTimes(1);

    // Após unsubscribe, não recebe mais notificações
    unsub();
    store.setState({ tripMode: 'competition' });
    expect(store.getState().tripMode).toBe('competition');
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
