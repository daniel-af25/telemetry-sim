/**
 * Ponto de entrada da aplicação 2D/3D (`telemetry-sim`):
 * liga o Web Worker (`telemetry.worker.ts`), o estado reativo (`AppStore`),
 * o relógio mestre a 60 FPS (`PlaybackClock`), o mapa MapLibre 3D DEM (`mapView.ts`),
 * o gravador de vídeo nativo (`videoRecorder.ts`) e a barra de controlos (`controlsBar.ts`).
 */
import './style.css';
import { createInterpolator, type SampleFrame } from './core/interpolator.ts';
import type { TelemetryTrackSoA } from './core/soa.ts';
import { resolveVehicleSpecs, type ResolvedVehicleSpecs } from './core/vehicleSpecs.ts';
import { createAppStore } from './state/appStore.ts';
import { createPlaybackClock } from './state/playbackClock.ts';
import {
  createBlackboxPanel,
  type BlackboxPanelController,
} from './ui/blackboxPanel.ts';
import { createControlsBar } from './ui/controlsBar.ts';
import { createHudCanvas } from './ui/hudCanvas.ts';
import { createMapView, type BasemapMode } from './ui/mapView.ts';
import { createThreeVehicleLayer } from './ui/threeLayer.ts';
import {
  createTripVideoRecorder,
  type VideoOverlaySnapshot,
} from './ui/videoRecorder.ts';
import type {
  ProcessedTrackPayload,
  VehicleSummary,
  WorkerRequest,
  WorkerResponse,
} from './workers/protocol.ts';

const GRAVITY_MS2 = 9.80665;

const appRoot = document.getElementById('app');
if (!appRoot) {
  throw new Error('Root element #app not found');
}

const mapContainer = document.createElement('div');
mapContainer.className = 'map-viewport';
appRoot.append(mapContainer);

// 1. Core reactive state & master 60 FPS clock
const store = createAppStore({
  tripMode: 'road',
  surfaceGrip: 0.95,
  ribbonMetric: 'kammIndex',
  cameraMode: 'chase',
  is3D: true,
});

const clock = createPlaybackClock(0);
const defaultVehicleSpecs: ResolvedVehicleSpecs = resolveVehicleSpecs(null, null, null);
let showForceVectors = false;
let lastTickSec = 0;

// 2. Three.js 3D Vehicle Custom Layer (Phase 4)
const threeLayer = createThreeVehicleLayer({
  initialSpecs: defaultVehicleSpecs,
  initialCameraMode: store.getState().cameraMode,
  onCameraModeChange: (mode) => {
    store.setState({ cameraMode: mode });
  },
});

// 3. MapLibre GL 2D/3D view (hosts the Three.js 3D vehicle layer across basemap switches)
let blackboxPanel: BlackboxPanelController | null = null;

const mapView = createMapView(mapContainer, {
  initial3D: store.getState().is3D,
  initialBasemap: 'dark',
  externalCameraControl: true,
  onStyleLoad: (map) => {
    if (!map.getLayer(threeLayer.layer.id)) {
      map.addLayer(threeLayer.layer);
    }
    blackboxPanel?.syncMapLayers(map);
  },
  onOfflineFallback: (isOffline) => {
    controls.setOfflineBadge(isOffline);
  },
});
mapView.setVehicleMarkerVisible(false);
mapView.setCameraMode(store.getState().cameraMode);

// 3. Dedicated telemetry Web Worker (Vite ESM)
const worker = new Worker(
  new URL('./workers/telemetry.worker.ts', import.meta.url),
  { type: 'module' },
);

let requestCounter = 0;
function nextRequestId(prefix: string): string {
  requestCounter += 1;
  return `${prefix}-${requestCounter}`;
}

function postWorker(req: WorkerRequest): void {
  worker.postMessage(req);
}

// Active session working state (kept in memory for live What-If reprocessing)
let lastCsvText: string | null = null;
let selectedVehicleId: number | undefined;
let payloadOverrideKg: number | null = null;
let activeProcessRequestId: string | null = null;
let pendingFitToTrack = false;
let currentTrack: TelemetryTrackSoA | null = null;
let latestFrame: SampleFrame | null = null;

function cancelActiveProcessing(): void {
  if (!activeProcessRequestId) return;
  postWorker({
    type: 'CANCEL',
    requestId: nextRequestId('cancel'),
    targetRequestId: activeProcessRequestId,
  });
  activeProcessRequestId = null;
}

function triggerCsvReprocess(fitToTrack: boolean): void {
  if (!lastCsvText) return;

  if (videoRecorder.isRecording()) {
    void videoRecorder.stopAndDownload(store.getState().sessionId ?? undefined);
  }

  cancelActiveProcessing();
  clock.pause();
  controls.setPlaybackState(false, clock.getRate(), clock.getDurationSec());

  const state = store.getState();
  const reqId = nextRequestId('primary');
  activeProcessRequestId = reqId;
  pendingFitToTrack = fitToTrack;

  store.setState({
    isLoading: true,
    loadingMessage: 'A processar CSV...',
    errorMessage: null,
  });

  postWorker({
    type: 'PROCESS_PRIMARY_CSV',
    requestId: reqId,
    csvText: lastCsvText,
    ...(selectedVehicleId !== undefined ? { vehicleId: selectedVehicleId } : {}),
    options: {
      tripMode: state.tripMode,
      calibrationMode: 'auto',
      vehicleOverrides: {
        surfaceGrip: state.surfaceGrip,
        ...(payloadOverrideKg !== null ? { payloadKg: payloadOverrideKg } : {}),
      },
    },
  });
}

// 4. Native WebM Video Recorder (2D & 3D)
const videoRecorder = createTripVideoRecorder({
  getSourceCanvas: () => mapView.getMap().getCanvas(),
  getOverlayData: (): VideoOverlaySnapshot => {
    const state = store.getState();
    const f = latestFrame;
    return {
      sessionLabel: state.sessionId ?? 'trip',
      vehicleName: state.vehicleSpecs?.name ?? 'Unknown Vehicle',
      is3D: state.is3D,
      speedKmh: f ? f.speedMs * 3.6 : 0,
      kammIndex: f ? f.kammIndex : 0,
      latG: f ? f.ay / GRAVITY_MS2 : 0,
      lonG: f ? f.ax / GRAVITY_MS2 : 0,
      roadGradePct: f ? f.roadGradePct : 0,
      timeSec: clock.getTimeSec(),
      durationSec: clock.getDurationSec(),
    };
  },
  onStateChange: (recording, elapsedSec) => {
    controls.setRecordingState(recording, elapsedSec);
  },
  onError: (message) => {
    store.setState({ errorMessage: message });
  },
});

// 5. UI Controls Bar & Event Wiring
const controls = createControlsBar(appRoot, store.getState(), {
  onCsvFileLoaded(csvText) {
    lastCsvText = csvText;
    // Reset explicit payload override so new CSV's own payload is picked up first
    payloadOverrideKg = null;
    triggerCsvReprocess(true);
  },

  onSearchVehicles(query) {
    postWorker({
      type: 'SEARCH_VEHICLES',
      requestId: nextRequestId('search'),
      query,
      limit: 25,
    });
  },

  onSelectVehicle(vehicle: VehicleSummary | null) {
    selectedVehicleId = vehicle ? vehicle.id : undefined;
    if (lastCsvText) {
      triggerCsvReprocess(false);
    }
  },

  onTripModeChange(mode) {
    if (store.getState().tripMode === mode) return;
    store.setState({ tripMode: mode });
    if (lastCsvText) {
      triggerCsvReprocess(false);
    }
  },

  onSurfaceGripChange(grip) {
    if (Math.abs(store.getState().surfaceGrip - grip) < 1e-4) return;
    store.setState({ surfaceGrip: grip });
    if (lastCsvText) {
      triggerCsvReprocess(false);
    }
  },

  onPayloadChange(payloadKg) {
    payloadOverrideKg = payloadKg;
    if (lastCsvText) {
      triggerCsvReprocess(false);
    }
  },

  onExaggerateChange(exaggerate) {
    store.setState({ exaggerate });
    if (latestFrame) {
      const specs = store.getState().vehicleSpecs ?? defaultVehicleSpecs;
      threeLayer.updateFrame(latestFrame, specs, {
        dtSec: 0,
        exaggerate,
        showForceVectors,
      });
    }
  },

  onToggleForceVectors(enabled) {
    showForceVectors = enabled;
    if (latestFrame) {
      const specs = store.getState().vehicleSpecs ?? defaultVehicleSpecs;
      threeLayer.updateFrame(latestFrame, specs, {
        dtSec: 0,
        exaggerate: store.getState().exaggerate,
        showForceVectors,
      });
    }
  },

  onRibbonMetricChange(metric) {
    store.setState({ ribbonMetric: metric });
    if (currentTrack) {
      mapView.renderTelemetryRibbon(currentTrack, metric, false);
    }
  },

  onBasemapChange(mode: BasemapMode) {
    mapView.setBasemap(mode);
  },

  onToggle3D(enabled) {
    store.setState({ is3D: enabled });
    mapView.set3DMode(enabled);
  },

  onCameraModeChange(mode) {
    store.setState({ cameraMode: mode });
    mapView.setCameraMode(mode);
    threeLayer.setCameraMode(mode);
  },

  onFitTrack() {
    store.setState({ cameraMode: 'free' });
    threeLayer.setCameraMode('free');
    mapView.fitToCurrentTrack();
  },

  onTogglePlay() {
    clock.toggle();
    controls.setPlaybackState(clock.isPlaying(), clock.getRate(), clock.getDurationSec());
  },

  onSeek(tSec) {
    clock.seek(tSec);
  },

  onRateChange(rate) {
    clock.setRate(rate);
    controls.setPlaybackState(clock.isPlaying(), clock.getRate(), clock.getDurationSec());
  },

  onToggleRecord() {
    if (videoRecorder.isRecording()) {
      void videoRecorder.stopAndDownload(store.getState().sessionId ?? undefined);
      return;
    }

    if (clock.getDurationSec() <= 0) return;

    store.setState({ errorMessage: null });
    if (!clock.isPlaying()) {
      clock.play();
      controls.setPlaybackState(clock.isPlaying(), clock.getRate(), clock.getDurationSec());
    }
    const started = videoRecorder.start();
    if (!started) {
      controls.setRecordingState(false, 0);
    }
  },
});

// Sync cold UI state whenever AppStore changes
store.subscribe((state) => {
  controls.syncState(state);
});
controls.syncState(store.getState());
controls.setBasemap(mapView.getBasemap());

// 5b. Black Box Incident Replay Panel (0.25x Chase Jump + MapLibre numbered markers)
blackboxPanel = createBlackboxPanel({
  container: appRoot,
  clock,
  store,
  map: mapView.getMap(),
  onBlackBoxJump: (_incident, win) => {
    threeLayer.setCameraMode('chase');
    controls.setPlaybackState(clock.isPlaying(), clock.getRate(), clock.getDurationSec());
    controls.setBlackBoxWindow(win);
  },
});

// 5c. 60 FPS HiDPI Canvas Telemetry HUD (Dual Asymmetric G-G, 4-wheel Fz, 5 Pillars, Extra Sparkline)
const hudCanvas = createHudCanvas({
  container: appRoot,
  initialCollapsed: true,
});

// Single 60 FPS hot path driven by master PlaybackClock
clock.onTick((tSec, frame) => {
  const rawDt = tSec - lastTickSec;
  const dtSec = rawDt > 0 && rawDt < 0.5 ? rawDt : 0;
  lastTickSec = tSec;
  latestFrame = frame;

  if (frame) {
    const state = store.getState();
    const activeSpecs = state.vehicleSpecs ?? defaultVehicleSpecs;
    threeLayer.updateFrame(frame, activeSpecs, {
      dtSec,
      exaggerate: state.exaggerate,
      showForceVectors,
    });
    mapView.updateVehiclePose(frame);
  }
  controls.updatePlaybackFrame(tSec, frame);
  hudCanvas.updateFrame(tSec, frame);

  // Sync play button icon and auto-finalize recording when track reaches the end
  if (!clock.isPlaying() && tSec >= clock.getDurationSec() && clock.getDurationSec() > 0) {
    controls.setPlaybackState(false, clock.getRate(), clock.getDurationSec());
    if (videoRecorder.isRecording()) {
      void videoRecorder.stopAndDownload(store.getState().sessionId ?? undefined);
    }
  }
});

// 6. Handle Worker responses
function applyPrimaryTrack(payload: ProcessedTrackPayload): void {
  const previousTimeSec = clock.getTimeSec();
  const shouldFit = pendingFitToTrack;
  pendingFitToTrack = false;

  currentTrack = payload.track;

  const interpolator = createInterpolator(payload.track);
  clock.setInterpolator(interpolator);
  threeLayer.setSpecs(payload.vehicleSpecs);
  threeLayer.setVisible(true);

  store.setState({
    sessionId: payload.sessionVehicleMeta?.sessionId ?? null,
    driverName: payload.sessionVehicleMeta?.driver ?? null,
    vehicleSpecs: payload.vehicleSpecs,
    kammLimits: payload.kammLimits,
    incidents: payload.incidents,
    pillars: payload.pillars,
    summary: payload.summary,
    calibrationWarning: payload.calibrationStats.warning ?? null,
    isLoading: false,
    loadingMessage: null,
    errorMessage: null,
  });

  if (payloadOverrideKg === null) {
    controls.setPayloadInputValue(payload.vehicleSpecs.payloadKg);
  }

  if (shouldFit) {
    store.setState({ cameraMode: 'free' });
    threeLayer.setCameraMode('free');
  }

  mapView.renderTelemetryRibbon(
    payload.track,
    store.getState().ribbonMetric,
    shouldFit,
  );

  blackboxPanel?.setIncidents(payload.incidents);
  controls.setBlackBoxWindow(null);
  hudCanvas.setSessionData({
    sessionId: payload.sessionVehicleMeta?.sessionId ?? null,
    driverName: payload.sessionVehicleMeta?.driver ?? null,
    vehicleName: payload.vehicleSpecs.name,
    metadata: payload.metadata,
    vehicleSpecs: payload.vehicleSpecs,
    kammLimits: payload.kammLimits,
    pillars: payload.pillars,
    summary: payload.summary,
    track: payload.track,
    extraChannels: payload.extraChannels,
    ...(payload.extraChannelSeries ? { extraChannelSeries: payload.extraChannelSeries } : {}),
  });

  const resumeTime = shouldFit
    ? 0
    : Math.min(previousTimeSec, interpolator.durationSec);
  clock.seek(resumeTime);
  controls.setPlaybackState(clock.isPlaying(), clock.getRate(), clock.getDurationSec());
}

worker.addEventListener('message', (event: MessageEvent<WorkerResponse>) => {
  const msg = event.data;
  if (!msg || typeof msg !== 'object') return;

  switch (msg.type) {
    case 'CATALOG_LOADED':
      controls.setCatalogLoadedCount(msg.count);
      break;

    case 'SEARCH_RESULTS':
      controls.setSearchResults(msg.results, msg.elapsedMs);
      break;

    case 'PROGRESS':
      if (msg.requestId === activeProcessRequestId) {
        controls.setProgress(msg.stage, msg.progress, msg.message);
      }
      break;

    case 'PROCESSED_TRACK':
      if (msg.role === 'primary' && msg.requestId === activeProcessRequestId) {
        activeProcessRequestId = null;
        controls.setProgress(null, 1);
        applyPrimaryTrack(msg.payload);
      }
      break;

    case 'CANCELLED':
      if (msg.targetRequestId === activeProcessRequestId) {
        activeProcessRequestId = null;
        controls.setProgress(null, 0);
        store.setState({ isLoading: false, loadingMessage: null });
      }
      break;

    case 'ERROR':
      if (msg.requestId === activeProcessRequestId) {
        activeProcessRequestId = null;
        controls.setProgress(null, 0);
      }
      store.setState({
        isLoading: false,
        loadingMessage: null,
        errorMessage: msg.message,
      });
      break;
  }
});

worker.addEventListener('error', (err) => {
  activeProcessRequestId = null;
  controls.setProgress(null, 0);
  store.setState({
    isLoading: false,
    loadingMessage: null,
    errorMessage: err.message || 'Erro inesperado no Web Worker de telemetria.',
  });
});

// 7. Boot: lazy-load 25k vehicle index in the background Worker
postWorker({
  type: 'LOAD_CATALOG',
  requestId: nextRequestId('catalog'),
});
