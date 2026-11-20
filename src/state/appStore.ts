/**
 * Store tipado minimalista (pub/sub sem frameworks externos) para o estado frio da aplicação:
 * sessão ativa, `vehicleSpecs`, `tripMode`, `surfaceGrip`, `ribbonMetric`, `cameraMode`,
 * `exaggerate`, incidentes, 5 Pilares, avisos de calibração e estado do Ghost Car.
 *
 * Testes:
 *   npx vitest run test/ui/appStore.test.ts
 */
import type { DynamicKammLimitsResult } from '../core/kamm.ts';
import type { TelemetryPipelineSummary } from '../core/pipeline.ts';
import type { DrivingSkillPillar, Incident } from '../core/scoring.ts';
import type { TripMode } from '../core/types.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';

export type CameraMode = 'chase' | 'topdown' | 'free';
export type RibbonMetric = 'kammIndex' | 'speed' | 'ay' | 'ax' | 'roadGradePct';

export interface GhostCarState {
  enabled: boolean;
  loaded: boolean;
  label: string | null;
  offsetSec: number;
}

export interface AppState {
  sessionId: string | null;
  driverName: string | null;
  vehicleSpecs: ResolvedVehicleSpecs | null;
  kammLimits: DynamicKammLimitsResult | null;
  tripMode: TripMode;
  surfaceGrip: number;
  ribbonMetric: RibbonMetric;
  cameraMode: CameraMode;
  exaggerate: number;
  is3D: boolean;
  incidents: Incident[];
  pillars: DrivingSkillPillar[];
  summary: TelemetryPipelineSummary | null;
  calibrationWarning: string | null;
  ghostCar: GhostCarState;
  isLoading: boolean;
  loadingMessage: string | null;
  errorMessage: string | null;
}

export type AppStoreListener = (
  state: Readonly<AppState>,
  prevState: Readonly<AppState>,
) => void;

export interface AppStore {
  getState(): Readonly<AppState>;
  setState(partial: Partial<AppState>): void;
  subscribe(listener: AppStoreListener): () => void;
  reset(): void;
}

function createDefaultState(): AppState {
  return {
    sessionId: null,
    driverName: null,
    vehicleSpecs: null,
    kammLimits: null,
    tripMode: 'road',
    surfaceGrip: 0.95,
    ribbonMetric: 'kammIndex',
    cameraMode: 'chase',
    exaggerate: 4,
    is3D: true,
    incidents: [],
    pillars: [],
    summary: null,
    calibrationWarning: null,
    ghostCar: {
      enabled: false,
      loaded: false,
      label: null,
      offsetSec: 0,
    },
    isLoading: false,
    loadingMessage: null,
    errorMessage: null,
  };
}

/**
 * Creates a lightweight typed pub/sub store for cold UI and session state.
 */
export function createAppStore(initial?: Partial<AppState>): AppStore {
  const initialSnapshot: AppState = {
    ...createDefaultState(),
    ...initial,
  };
  let state: AppState = { ...initialSnapshot };
  const listeners = new Set<AppStoreListener>();

  function getState(): Readonly<AppState> {
    return state;
  }

  function setState(partial: Partial<AppState>): void {
    const prev = state;
    state = { ...state, ...partial };
    for (const listener of listeners) {
      listener(state, prev);
    }
  }

  function subscribe(listener: AppStoreListener): () => void {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }

  function reset(): void {
    setState({ ...initialSnapshot });
  }

  return {
    getState,
    setState,
    subscribe,
    reset,
  };
}
