/**
 * Barra superior de telemetria, painel lateral retrátil (CSV drag-and-drop,
 * autocomplete de 25k veículos, controlos What-If) e dock inferior de timeline 60 FPS.
 * Todas as strings dinâmicas usam exclusivamente `textContent` ou `escapeHtml()`.
 */
import type { SampleFrame } from '../core/interpolator.ts';
import type { TripMode } from '../core/types.ts';
import type { AppState, CameraMode, RibbonMetric } from '../state/appStore.ts';
import type { PlaybackRate } from '../state/playbackClock.ts';
import type { VehicleSummary, WorkerProgressStage } from '../workers/protocol.ts';
import type { BlackBoxWindow } from './blackboxPanel.ts';
import {
  getRibbonMetricMeta,
  RDYLGN_R_PALETTE,
  type BasemapMode,
} from './mapView.ts';
import { escapeHtml } from './sanitize.ts';

const GRAVITY_MS2 = 9.80665;
const PLAYBACK_RATES: readonly PlaybackRate[] = [0.25, 0.5, 1, 2, 4];
const GRIP_PRESETS: ReadonlyArray<{ label: string; value: number }> = [
  { label: 'Seco 0.95', value: 0.95 },
  { label: 'Chuva 0.55', value: 0.55 },
  { label: 'Gelo 0.25', value: 0.25 },
];
const RIBBON_OPTIONS: ReadonlyArray<{ value: RibbonMetric; label: string }> = [
  { value: 'kammIndex', label: 'Kamm Index' },
  { value: 'speed', label: 'Velocidade (km/h)' },
  { value: 'ay', label: 'Lateral |ay| (G)' },
  { value: 'ax', label: 'Longitudinal |ax| (G)' },
  { value: 'roadGradePct', label: 'Declive (%)' },
];
const CAMERA_OPTIONS: ReadonlyArray<{ value: CameraMode; label: string }> = [
  { value: 'chase', label: 'Chase' },
  { value: 'topdown', label: 'Top' },
  { value: 'free', label: 'Livre' },
];
const BASEMAP_OPTIONS: ReadonlyArray<{ value: BasemapMode; label: string }> = [
  { value: 'dark', label: 'Escuro 3D' },
  { value: 'satellite', label: 'Satélite' },
  { value: 'liberty', label: 'Vetorial' },
];

export interface ControlsBarCallbacks {
  onCsvFileLoaded(csvText: string, fileName: string): void;
  onSearchVehicles(query: string): void;
  onSelectVehicle(vehicle: VehicleSummary | null): void;
  onTripModeChange(mode: TripMode): void;
  onSurfaceGripChange(grip: number): void;
  onPayloadChange(payloadKg: number): void;
  onExaggerateChange(exaggerate: number): void;
  onToggleForceVectors(enabled: boolean): void;
  onRibbonMetricChange(metric: RibbonMetric): void;
  onBasemapChange(mode: BasemapMode): void;
  onToggle3D(enabled: boolean): void;
  onToggleLabView(open: boolean): void;
  onCameraModeChange(mode: CameraMode): void;
  onFitTrack(): void;
  onTogglePlay(): void;
  onSeek(tSec: number): void;
  onRateChange(rate: PlaybackRate): void;
  onToggleRecord(): void;
  onExportSchema6(): void;
}

export interface ControlsBarController {
  syncState(state: Readonly<AppState>): void;
  setSearchResults(results: readonly VehicleSummary[], elapsedMs: number): void;
  setProgress(stage: WorkerProgressStage | null, progress: number, message?: string): void;
  setPlaybackState(isPlaying: boolean, rate: PlaybackRate, durationSec: number): void;
  setBlackBoxWindow(window: BlackBoxWindow | null): void;
  setRecordingState(recording: boolean, elapsedSec: number): void;
  setBasemap(mode: BasemapMode): void;
  updatePlaybackFrame(tSec: number, frame: SampleFrame | null): void;
  setSelectedVehicleLabel(label: string | null): void;
  setPayloadInputValue(payloadKg: number): void;
  setCatalogLoadedCount(count: number): void;
  setOfflineBadge(isOffline: boolean): void;
  dispose(): void;
}

function formatTimeMMSS(sec: number): string {
  const safe = Number.isFinite(sec) && sec > 0 ? sec : 0;
  const mins = Math.floor(safe / 60);
  const rem = safe - mins * 60;
  const wholeSec = Math.floor(rem);
  const tenths = Math.floor((rem - wholeSec) * 10);
  return `${String(mins).padStart(2, '0')}:${String(wholeSec).padStart(2, '0')}.${tenths}`;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function isEditableElement(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable;
}

/**
 * Builds and manages the Dark Motorsport Telemetry UI overlays (top HUD bar,
 * collapsible left controls panel, bottom 60 FPS timeline dock, progress pill,
 * and drag-and-drop empty state).
 */
export function createControlsBar(
  root: HTMLElement,
  initialState: Readonly<AppState>,
  callbacks: ControlsBarCallbacks,
): ControlsBarController {
  let durationSec = 0;
  let isScrubbing = false;
  let searchDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let gripDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let payloadDebounceTimer: ReturnType<typeof setTimeout> | null = null;
  let hasTrackLoaded = false;

  // -------------------------------------------------------------------------
  // 1. TOP TELEMETRY BAR
  // -------------------------------------------------------------------------
  const topBar = el('header', 'top-bar glass-panel');

  const brandGroup = el('div', 'top-bar__brand');
  const brandTitle = el('span', 'brand-title', 'TELEMETRY-SIM');
  const offlineBadge = el('span', 'status-pill status-pill--offline is-hidden', 'OFFLINE MAP');
  const sessionLabel = el('span', 'session-badge', 'Sem sessão carregada');
  brandGroup.append(brandTitle, offlineBadge, sessionLabel);

  const livePills = el('div', 'live-pills');
  const pillSpeed = createTelemetryPill('VEL', '0.0', 'km/h');
  const pillKamm = createTelemetryPill('KAMM', '0.00', '×');
  const pillLat = createTelemetryPill('LAT', '+0.00', 'G');
  const pillLon = createTelemetryPill('LON', '+0.00', 'G');
  const pillGrade = createTelemetryPill('DECLIVE', '+0.0', '%');
  livePills.append(
    pillSpeed.root,
    pillKamm.root,
    pillLat.root,
    pillLon.root,
    pillGrade.root,
  );

  const mapTools = el('div', 'top-bar__tools');

  // Ribbon metric selector + gradient legend
  const ribbonWrap = el('div', 'ribbon-tool');
  const ribbonSelect = el('select', 'telemetry-select');
  ribbonSelect.setAttribute('aria-label', 'Métrica do Telemetry Ribbon');
  for (const opt of RIBBON_OPTIONS) {
    const option = document.createElement('option');
    option.value = opt.value;
    option.textContent = opt.label;
    if (opt.value === initialState.ribbonMetric) option.selected = true;
    ribbonSelect.append(option);
  }

  const legendWrap = el('div', 'ribbon-legend');
  const legendMin = el('span', 'ribbon-legend__bound tabular-nums', '0');
  const legendBar = el('div', 'ribbon-legend__bar');
  legendBar.style.background = `linear-gradient(90deg, ${RDYLGN_R_PALETTE.join(', ')})`;
  const legendMax = el('span', 'ribbon-legend__bound tabular-nums', '1.2×');
  legendWrap.append(legendMin, legendBar, legendMax);
  ribbonWrap.append(ribbonSelect, legendWrap);

  // Basemap selector (Escuro 3D | Satélite | Vetorial)
  const basemapGroup = el('div', 'segmented-group');
  basemapGroup.setAttribute('role', 'group');
  basemapGroup.setAttribute('aria-label', 'Mapa base');
  const basemapButtons = new Map<BasemapMode, HTMLButtonElement>();
  for (const bm of BASEMAP_OPTIONS) {
    const btn = el('button', 'seg-btn', bm.label);
    btn.type = 'button';
    if (bm.value === 'dark') btn.classList.add('is-active');
    btn.addEventListener('click', () => {
      setBasemap(bm.value);
      callbacks.onBasemapChange(bm.value);
    });
    basemapButtons.set(bm.value, btn);
    basemapGroup.append(btn);
  }

  // Camera segmented buttons
  const cameraGroup = el('div', 'segmented-group');
  cameraGroup.setAttribute('role', 'group');
  cameraGroup.setAttribute('aria-label', 'Modo de câmara');
  const cameraButtons = new Map<CameraMode, HTMLButtonElement>();
  for (const cam of CAMERA_OPTIONS) {
    const btn = el('button', 'seg-btn', cam.label);
    btn.type = 'button';
    if (cam.value === initialState.cameraMode) btn.classList.add('is-active');
    btn.addEventListener('click', () => callbacks.onCameraModeChange(cam.value));
    cameraButtons.set(cam.value, btn);
    cameraGroup.append(btn);
  }

  // Quick toggle 3D Force Vectors, Fit-track & 2D/3D toggle
  const forceVectorsQuickBtn = el('button', 'icon-btn', 'Fz 3D');
  forceVectorsQuickBtn.type = 'button';
  forceVectorsQuickBtn.title = 'Mostrar/ocultar vetores verticais Fz e discos de aderência 3D nos 4 pneus';
  forceVectorsQuickBtn.setAttribute('aria-pressed', 'false');

  const fitBtn = el('button', 'icon-btn', 'Enquadrar');
  fitBtn.type = 'button';
  fitBtn.title = 'Enquadrar percurso no mapa';
  fitBtn.addEventListener('click', () => callbacks.onFitTrack());

  const toggle3DBtn = el('button', 'mode-3d-btn', initialState.is3D ? '3D' : '2D');
  toggle3DBtn.type = 'button';
  toggle3DBtn.title = 'Alternar vista 2D / 3D com terreno DEM';
  if (initialState.is3D) toggle3DBtn.classList.add('is-active');
  toggle3DBtn.addEventListener('click', () => {
    const next = !toggle3DBtn.classList.contains('is-active');
    callbacks.onToggle3D(next);
  });

  const labViewBtn = el('button', 'icon-btn lab-trigger-btn', 'Lab 2D/3D');
  labViewBtn.type = 'button';
  labViewBtn.disabled = true;
  labViewBtn.setAttribute('aria-pressed', String(initialState.labViewOpen));
  labViewBtn.title = initialState.is3D
    ? 'Abrir Lab 3D Isométrico (view3d.py ao vivo a 60 FPS)'
    : 'Abrir Lab 2D Top-Down (topdown.py ao vivo a 60 FPS)';
  labViewBtn.addEventListener('click', () => {
    const next = !labViewBtn.classList.contains('is-active');
    callbacks.onToggleLabView(next);
  });

  mapTools.append(
    ribbonWrap,
    basemapGroup,
    cameraGroup,
    forceVectorsQuickBtn,
    fitBtn,
    toggle3DBtn,
    labViewBtn,
  );
  topBar.append(brandGroup, livePills, mapTools);

  // -------------------------------------------------------------------------
  // 2. COLLAPSIBLE LEFT CONTROL PANEL
  // -------------------------------------------------------------------------
  const sideShell = el('div', 'side-shell');
  const collapseBtn = el('button', 'collapse-toggle glass-panel', '◀');
  collapseBtn.type = 'button';
  collapseBtn.title = 'Recolher / expandir painel lateral';
  collapseBtn.setAttribute('aria-expanded', 'true');

  const sidePanel = el('aside', 'side-panel glass-panel');

  collapseBtn.addEventListener('click', () => {
    const collapsed = sideShell.classList.toggle('is-collapsed');
    collapseBtn.textContent = collapsed ? '▶' : '◀';
    collapseBtn.setAttribute('aria-expanded', String(!collapsed));
  });

  // Section A: CSV Upload & Drag-and-Drop
  const uploadSection = el('section', 'panel-section');
  uploadSection.append(el('h2', 'panel-heading', 'IMPORTAR TELEMETRIA CSV'));

  const dropZone = el('label', 'drop-zone');
  dropZone.tabIndex = 0;
  const fileInput = document.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.csv,text/csv';
  fileInput.className = 'sr-only';

  const dropTitle = el('span', 'drop-zone__title', 'Arrastar CSV ou clicar para escolher');
  const dropHint = el('span', 'drop-zone__hint', 'Suporta LABSIS v2.2 (33 col.) e ISO 8855');
  const fileBadge = el('span', 'drop-zone__file is-hidden');
  dropZone.append(fileInput, dropTitle, dropHint, fileBadge);
  uploadSection.append(dropZone);

  const handleFile = (file: File | undefined) => {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        fileBadge.textContent = file.name;
        fileBadge.classList.remove('is-hidden');
        callbacks.onCsvFileLoaded(reader.result, file.name);
      }
    };
    reader.readAsText(file, 'utf-8');
  };

  fileInput.addEventListener('change', () => {
    handleFile(fileInput.files?.[0]);
    fileInput.value = '';
  });

  dropZone.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      fileInput.click();
    }
  });

  // Section B: Vehicle Autocomplete (25k catalog)
  const vehicleSection = el('section', 'panel-section');
  const vehicleHeader = el('div', 'section-row');
  vehicleHeader.append(el('h2', 'panel-heading', 'VEÍCULO (CATÁLOGO)'));
  const catalogBadge = el('span', 'micro-badge tabular-nums', 'A carregar...');
  vehicleHeader.append(catalogBadge);

  const searchWrap = el('div', 'autocomplete-wrap');
  const searchInput = document.createElement('input');
  searchInput.type = 'search';
  searchInput.className = 'telemetry-input';
  searchInput.placeholder = 'Pesquisar marca, modelo, HP...';
  searchInput.autocomplete = 'off';
  searchInput.setAttribute('aria-label', 'Pesquisar veículo no catálogo');

  const clearVehicleBtn = el('button', 'clear-btn is-hidden', '×');
  clearVehicleBtn.type = 'button';
  clearVehicleBtn.title = 'Limpar override de veículo (usar CSV)';

  const dropdown = el('ul', 'autocomplete-list is-hidden');
  dropdown.setAttribute('role', 'listbox');

  const searchMeta = el('div', 'field-hint', 'Opcional: sobrepõe o veículo do CSV');

  searchWrap.append(searchInput, clearVehicleBtn, dropdown);
  vehicleSection.append(vehicleHeader, searchWrap, searchMeta);

  searchInput.addEventListener('input', () => {
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
    const q = searchInput.value;
    searchDebounceTimer = setTimeout(() => {
      callbacks.onSearchVehicles(q);
    }, 120);
  });

  searchInput.addEventListener('focus', () => {
    if (searchInput.value.trim().length > 0) {
      callbacks.onSearchVehicles(searchInput.value);
    }
  });

  clearVehicleBtn.addEventListener('click', () => {
    searchInput.value = '';
    clearVehicleBtn.classList.add('is-hidden');
    dropdown.classList.add('is-hidden');
    searchMeta.textContent = 'Veículo automático a partir do CSV';
    callbacks.onSelectVehicle(null);
  });

  const handleDocClick = (e: MouseEvent) => {
    if (!(e.target instanceof Node) || !searchWrap.contains(e.target)) {
      dropdown.classList.add('is-hidden');
    }
  };
  document.addEventListener('click', handleDocClick);

  // Section C: What-If Physics Parameters
  const physicsSection = el('section', 'panel-section');
  physicsSection.append(el('h2', 'panel-heading', 'PARÂMETROS WHAT-IF'));

  // TripMode toggle
  const modeRow = el('div', 'control-block');
  modeRow.append(el('span', 'control-label', 'Modo de Envolvente Kamm'));
  const tripModeGroup = el('div', 'segmented-group segmented-group--full');
  const roadBtn = el('button', 'seg-btn', 'Estrada (Road)');
  roadBtn.type = 'button';
  const compBtn = el('button', 'seg-btn', 'Competição');
  compBtn.type = 'button';
  if (initialState.tripMode === 'road') roadBtn.classList.add('is-active');
  else compBtn.classList.add('is-active');

  roadBtn.addEventListener('click', () => callbacks.onTripModeChange('road'));
  compBtn.addEventListener('click', () => callbacks.onTripModeChange('competition'));
  tripModeGroup.append(roadBtn, compBtn);
  modeRow.append(tripModeGroup);

  // SurfaceGrip slider + presets
  const gripBlock = el('div', 'control-block');
  const gripHeader = el('div', 'section-row');
  gripHeader.append(el('span', 'control-label', 'Aderência do Piso (μ)'));
  const gripValLabel = el('span', 'control-value tabular-nums', initialState.surfaceGrip.toFixed(2));
  gripHeader.append(gripValLabel);

  const gripSlider = document.createElement('input');
  gripSlider.type = 'range';
  gripSlider.className = 'telemetry-slider';
  gripSlider.min = '0.20';
  gripSlider.max = '1.10';
  gripSlider.step = '0.01';
  gripSlider.value = initialState.surfaceGrip.toFixed(2);
  gripSlider.setAttribute('aria-label', 'Aderência do piso');

  const presetRow = el('div', 'preset-row');
  const presetBtns: Array<{ btn: HTMLButtonElement; value: number }> = [];
  for (const preset of GRIP_PRESETS) {
    const pBtn = el('button', 'preset-btn', preset.label);
    pBtn.type = 'button';
    pBtn.addEventListener('click', () => {
      gripSlider.value = preset.value.toFixed(2);
      gripValLabel.textContent = preset.value.toFixed(2);
      updateGripPresetHighlight(preset.value);
      callbacks.onSurfaceGripChange(preset.value);
    });
    presetBtns.push({ btn: pBtn, value: preset.value });
    presetRow.append(pBtn);
  }

  function updateGripPresetHighlight(val: number): void {
    for (const p of presetBtns) {
      p.btn.classList.toggle('is-active', Math.abs(p.value - val) < 0.015);
    }
  }
  updateGripPresetHighlight(initialState.surfaceGrip);

  gripSlider.addEventListener('input', () => {
    const val = Number(gripSlider.value);
    gripValLabel.textContent = val.toFixed(2);
    updateGripPresetHighlight(val);
    if (gripDebounceTimer !== null) clearTimeout(gripDebounceTimer);
    gripDebounceTimer = setTimeout(() => {
      callbacks.onSurfaceGripChange(val);
    }, 150);
  });

  gripBlock.append(gripHeader, gripSlider, presetRow);

  // PayloadKg numeric input
  const payloadBlock = el('div', 'control-block');
  const payloadRow = el('div', 'section-row');
  payloadRow.append(el('label', 'control-label', 'Carga / Passageiros (kg)'));
  const payloadInput = document.createElement('input');
  payloadInput.type = 'number';
  payloadInput.className = 'telemetry-input telemetry-input--compact tabular-nums';
  payloadInput.min = '0';
  payloadInput.max = '600';
  payloadInput.step = '5';
  payloadInput.value = '75';
  payloadInput.setAttribute('aria-label', 'Carga útil em quilogramas');
  payloadRow.append(payloadInput);
  payloadBlock.append(payloadRow);

  payloadInput.addEventListener('input', () => {
    const raw = Number(payloadInput.value);
    if (!Number.isFinite(raw)) return;
    const clamped = Math.max(0, Math.min(600, raw));
    if (payloadDebounceTimer !== null) clearTimeout(payloadDebounceTimer);
    payloadDebounceTimer = setTimeout(() => {
      callbacks.onPayloadChange(clamped);
    }, 180);
  });

  // Section C0: Visualização 3D (exagero de suspensão 1x..6x + vetores físicos Fz/aderência)
  const visual3DSection = el('section', 'panel-section');
  visual3DSection.append(el('h2', 'panel-heading', 'VISUALIZAÇÃO 3D'));

  const exagBlock = el('div', 'control-block');
  const exagHeader = el('div', 'section-row');
  exagHeader.append(el('span', 'control-label', 'Exagero Suspensão (Roll/Pitch)'));
  const exagValLabel = el(
    'span',
    'control-value tabular-nums',
    `${initialState.exaggerate.toFixed(1)}×`,
  );
  exagHeader.append(exagValLabel);

  const exagSlider = document.createElement('input');
  exagSlider.type = 'range';
  exagSlider.className = 'telemetry-slider';
  exagSlider.min = '1.0';
  exagSlider.max = '6.0';
  exagSlider.step = '0.5';
  exagSlider.value = initialState.exaggerate.toFixed(1);
  exagSlider.setAttribute('aria-label', 'Exagero da suspensão 3D');
  exagSlider.addEventListener('input', () => {
    const val = Number(exagSlider.value);
    exagValLabel.textContent = `${val.toFixed(1)}×`;
    callbacks.onExaggerateChange(val);
  });
  exagBlock.append(exagHeader, exagSlider);

  const vectorsRow = el('div', 'section-row');
  vectorsRow.append(el('span', 'control-label', 'Vetores Fz & Aderência 3D'));
  const forceVectorsBtn = el('button', 'preset-btn', 'OFF');
  forceVectorsBtn.type = 'button';
  forceVectorsBtn.style.minWidth = '64px';
  forceVectorsBtn.setAttribute('aria-pressed', 'false');

  // Floating 3D Force Vectors mini-legend (hidden by default, synced with toggle)
  const forceVectorsLegend = el('aside', 'force-vectors-legend glass-panel is-hidden');
  forceVectorsLegend.setAttribute('aria-label', 'Legenda dos vetores físicos 3D');
  forceVectorsLegend.append(el('div', 'force-vectors-legend__title', 'VETORES 3D (ISO 8855)'));

  const forceLegendList = el('ul', 'force-vectors-legend__list');
  const forceLegendItems: ReadonlyArray<{ swatch: string; label: string; isGradient?: boolean }> = [
    { swatch: '#38bdf8', label: 'Fz vertical · Carga/roda' },
    { swatch: '#10b981', label: '+ax · Aceleração' },
    { swatch: '#f43f5e', label: '-ax · Travagem' },
    { swatch: '#f59e0b', label: '±ay · Lateral (curva)' },
    { swatch: '#fb923c', label: 'Resultante · Kamm' },
    {
      swatch: `linear-gradient(90deg, ${RDYLGN_R_PALETTE.join(', ')})`,
      label: 'Discos · Uso de aderência',
      isGradient: true,
    },
  ];
  for (const item of forceLegendItems) {
    const li = el('li', 'force-vectors-legend__item');
    const swatch = el(
      'span',
      item.isGradient
        ? 'force-vectors-legend__swatch force-vectors-legend__swatch--gradient'
        : 'force-vectors-legend__swatch',
    );
    swatch.style.background = item.swatch;
    const label = el('span', 'force-vectors-legend__label', item.label);
    li.append(swatch, label);
    forceLegendList.append(li);
  }
  forceVectorsLegend.append(forceLegendList);

  let forceVectorsOn = false;
  function setForceVectorsUI(enabled: boolean): void {
    forceVectorsOn = enabled;
    forceVectorsBtn.textContent = enabled ? 'ON' : 'OFF';
    forceVectorsBtn.classList.toggle('is-active', enabled);
    forceVectorsBtn.setAttribute('aria-pressed', String(enabled));
    forceVectorsQuickBtn.classList.toggle('is-active', enabled);
    forceVectorsQuickBtn.setAttribute('aria-pressed', String(enabled));
    forceVectorsLegend.classList.toggle('is-hidden', !enabled);
  }
  const toggleForceVectors = () => {
    const next = !forceVectorsOn;
    setForceVectorsUI(next);
    callbacks.onToggleForceVectors(next);
  };
  forceVectorsBtn.addEventListener('click', toggleForceVectors);
  forceVectorsQuickBtn.addEventListener('click', toggleForceVectors);
  vectorsRow.append(forceVectorsBtn);
  visual3DSection.append(exagBlock, vectorsRow);

  physicsSection.append(modeRow, gripBlock, payloadBlock);

  // Section D: Session Diagnostics & Alerts
  const summarySection = el('section', 'panel-section');
  summarySection.append(el('h2', 'panel-heading', 'RESUMO DA SESSÃO'));
  const summaryGrid = el('div', 'summary-grid');
  const statScore = createSummaryCard('SCORE', '—');
  const statLimits = createSummaryCard('LIMITES KAMM', '—');
  const statDist = createSummaryCard('DISTÂNCIA', '—');
  const statIncidents = createSummaryCard('INCIDENTES', '—');
  summaryGrid.append(statScore.root, statLimits.root, statDist.root, statIncidents.root);

  const warningBanner = el('div', 'alert-banner alert-banner--warn is-hidden');
  const errorBanner = el('div', 'alert-banner alert-banner--error is-hidden');

  summarySection.append(summaryGrid, warningBanner, errorBanner);

  sidePanel.append(uploadSection, vehicleSection, visual3DSection, physicsSection, summarySection);
  sideShell.append(sidePanel, collapseBtn);

  // -------------------------------------------------------------------------
  // 3. BOTTOM TIMELINE DOCK (60 FPS)
  // -------------------------------------------------------------------------
  const timelineDock = el('footer', 'timeline-dock glass-panel');

  const playBtn = el('button', 'play-btn', '▶');
  playBtn.type = 'button';
  playBtn.title = 'Reproduzir / Pausar (Espaço)';
  playBtn.setAttribute('aria-label', 'Reproduzir ou pausar');
  playBtn.disabled = true;
  playBtn.addEventListener('click', () => callbacks.onTogglePlay());

  const scrubberWrap = el('div', 'scrubber-wrap');
  const blackboxWindowEl = el('div', 'timeline-blackbox-window is-hidden');
  const blackboxTickEl = el('span', 'timeline-blackbox-window__tick');
  blackboxWindowEl.append(blackboxTickEl);

  const scrubber = document.createElement('input');
  scrubber.type = 'range';
  scrubber.className = 'telemetry-slider telemetry-slider--timeline';
  scrubber.min = '0';
  scrubber.max = '100';
  scrubber.step = '0.01';
  scrubber.value = '0';
  scrubber.disabled = true;
  scrubber.setAttribute('aria-label', 'Linha temporal da viagem');

  scrubber.addEventListener('pointerdown', () => {
    isScrubbing = true;
  });
  const endScrub = () => {
    isScrubbing = false;
  };
  scrubber.addEventListener('pointerup', endScrub);
  scrubber.addEventListener('pointercancel', endScrub);
  scrubber.addEventListener('input', () => {
    const nextT = Number(scrubber.value);
    if (Number.isFinite(nextT)) {
      callbacks.onSeek(nextT);
    }
  });
  scrubberWrap.append(blackboxWindowEl, scrubber);

  const timeDisplay = el('div', 'time-display tabular-nums', '00:00.0 / 00:00.0');

  const rateGroup = el('div', 'segmented-group');
  rateGroup.setAttribute('role', 'group');
  rateGroup.setAttribute('aria-label', 'Velocidade de reprodução');
  const rateButtons = new Map<PlaybackRate, HTMLButtonElement>();
  for (const r of PLAYBACK_RATES) {
    const rBtn = el('button', 'seg-btn tabular-nums', `${r}x`);
    rBtn.type = 'button';
    if (r === 1) rBtn.classList.add('is-active');
    rBtn.addEventListener('click', () => callbacks.onRateChange(r));
    rateButtons.set(r, rBtn);
    rateGroup.append(rBtn);
  }

  const exportSchema6Btn = el('button', 'icon-btn export-schema6-btn', 'Exportar # schema=6');
  exportSchema6Btn.type = 'button';
  exportSchema6Btn.disabled = true;
  exportSchema6Btn.title = 'Exportar Recorte # schema=6 (10–20 s) centrado na posição atual da timeline para view3d.py / topdown.py';
  exportSchema6Btn.addEventListener('click', () => callbacks.onExportSchema6());

  const recordBtn = el('button', 'rec-btn');
  recordBtn.type = 'button';
  recordBtn.disabled = true;
  recordBtn.title = 'Gravar e descarregar vídeo WebM do trajeto (2D ou 3D)';
  const recordDot = el('span', 'rec-btn__dot');
  const recordLabel = el('span', 'rec-btn__label tabular-nums', 'Gravar Vídeo');
  recordBtn.append(recordDot, recordLabel);
  recordBtn.addEventListener('click', () => callbacks.onToggleRecord());

  timelineDock.append(playBtn, scrubberWrap, timeDisplay, rateGroup, exportSchema6Btn, recordBtn);

  // -------------------------------------------------------------------------
  // 4. PROGRESS OVERLAY, EMPTY STATE & GLOBAL DRAG-AND-DROP
  // -------------------------------------------------------------------------
  const progressOverlay = el('div', 'progress-pill glass-panel is-hidden');
  const progressBarTrack = el('div', 'progress-pill__track');
  const progressBarFill = el('div', 'progress-pill__fill');
  progressBarTrack.append(progressBarFill);
  const progressText = el('span', 'progress-pill__text', 'A processar...');
  progressOverlay.append(progressText, progressBarTrack);

  const emptyState = el('div', 'empty-state glass-panel');
  const emptyBadge = el('span', 'empty-state__tag', 'FASE 3 • MAPLIBRE 3D DEM & TELEMETRY RIBBON');
  const emptyTitle = el('h1', 'empty-state__title', 'Importe uma sessão CSV para iniciar');
  const emptyDesc = el(
    'p',
    'empty-state__desc',
    'Arraste um ficheiro session_TRIP_*.csv para qualquer ponto da janela ou clique abaixo para reconstruir a trajetória 3D, limites Kamm v2.2 e reprodução a 60 FPS.',
  );
  const emptyAction = el('button', 'primary-btn', 'Carregar Ficheiro CSV');
  emptyAction.type = 'button';
  emptyAction.addEventListener('click', () => fileInput.click());
  emptyState.append(emptyBadge, emptyTitle, emptyDesc, emptyAction);

  const dragOverlay = el('div', 'drag-overlay is-hidden');
  dragOverlay.append(el('div', 'drag-overlay__card', 'Largar ficheiro .CSV para processar no Web Worker'));

  // Global window drag-and-drop
  let dragCounter = 0;
  const onDragEnter = (e: DragEvent) => {
    e.preventDefault();
    dragCounter += 1;
    dragOverlay.classList.remove('is-hidden');
  };
  const onDragOver = (e: DragEvent) => {
    e.preventDefault();
  };
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault();
    dragCounter = Math.max(0, dragCounter - 1);
    if (dragCounter === 0) {
      dragOverlay.classList.add('is-hidden');
    }
  };
  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    dragCounter = 0;
    dragOverlay.classList.add('is-hidden');
    const file = e.dataTransfer?.files[0];
    handleFile(file);
  };

  window.addEventListener('dragenter', onDragEnter);
  window.addEventListener('dragover', onDragOver);
  window.addEventListener('dragleave', onDragLeave);
  window.addEventListener('drop', onDrop);

  // Spacebar Play/Pause shortcut outside editable controls
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.code === 'Space' && !isEditableElement(e.target) && hasTrackLoaded) {
      e.preventDefault();
      callbacks.onTogglePlay();
    }
  };
  window.addEventListener('keydown', onKeyDown);

  // Ribbon select listener
  ribbonSelect.addEventListener('change', () => {
    const val = ribbonSelect.value as RibbonMetric;
    updateLegend(val);
    callbacks.onRibbonMetricChange(val);
  });

  function updateLegend(metricKey: RibbonMetric): void {
    const meta = getRibbonMetricMeta(metricKey);
    legendMin.textContent = `${meta.min}`;
    legendMax.textContent = `${meta.max}${meta.unit}`;
  }
  updateLegend(initialState.ribbonMetric);

  root.append(
    topBar,
    sideShell,
    timelineDock,
    forceVectorsLegend,
    progressOverlay,
    emptyState,
    dragOverlay,
  );

  // -------------------------------------------------------------------------
  // CONTROLLER METHODS
  // -------------------------------------------------------------------------

  function syncState(state: Readonly<AppState>): void {
    hasTrackLoaded = state.summary !== null;
    emptyState.classList.toggle('is-hidden', hasTrackLoaded || state.isLoading);

    // Session badge (strictly sanitized via textContent)
    if (state.vehicleSpecs) {
      const parts: string[] = [];
      if (state.sessionId) parts.push(state.sessionId);
      if (state.driverName) parts.push(state.driverName);
      parts.push(
        `${state.vehicleSpecs.name} (${Math.round(state.vehicleSpecs.grossMassKg)} kg)`,
      );
      sessionLabel.textContent = parts.join(' • ');
    } else {
      sessionLabel.textContent = 'Sem sessão carregada';
    }

    // Mode buttons & ribbon
    roadBtn.classList.toggle('is-active', state.tripMode === 'road');
    compBtn.classList.toggle('is-active', state.tripMode === 'competition');
    ribbonSelect.value = state.ribbonMetric;
    updateLegend(state.ribbonMetric);

    toggle3DBtn.classList.toggle('is-active', state.is3D);
    toggle3DBtn.textContent = state.is3D ? '3D' : '2D';

    labViewBtn.classList.toggle('is-active', state.labViewOpen);
    labViewBtn.setAttribute('aria-pressed', String(state.labViewOpen));
    labViewBtn.title = state.is3D
      ? 'Abrir/fechar Lab 3D Isométrico (view3d.py ao vivo a 60 FPS)'
      : 'Abrir/fechar Lab 2D Top-Down (topdown.py ao vivo a 60 FPS)';

    exagSlider.value = state.exaggerate.toFixed(1);
    exagValLabel.textContent = `${state.exaggerate.toFixed(1)}×`;

    for (const [mode, btn] of cameraButtons.entries()) {
      btn.classList.toggle('is-active', mode === state.cameraMode);
    }

    gripSlider.value = state.surfaceGrip.toFixed(2);
    gripValLabel.textContent = state.surfaceGrip.toFixed(2);
    updateGripPresetHighlight(state.surfaceGrip);

    // Summary KPIs
    if (state.summary) {
      statScore.val.textContent = state.summary.isSufficientData
        ? `${state.summary.finalScore}/100 (${state.summary.grade})`
        : 'N/A (<5m)';
      statDist.val.textContent = `${state.summary.totalDistanceKm.toFixed(2)} km`;
      statIncidents.val.textContent = String(state.summary.incidentCount);
    } else {
      statScore.val.textContent = '—';
      statDist.val.textContent = '—';
      statIncidents.val.textContent = '—';
    }

    if (state.kammLimits) {
      statLimits.val.textContent =
        `${state.kammLimits.accelLimit.toFixed(2)} / ${state.kammLimits.brakeLimit.toFixed(2)} / ${state.kammLimits.latLimit.toFixed(2)} G`;
    } else {
      statLimits.val.textContent = '—';
    }

    // Alerts (sanitized via textContent / escapeHtml)
    if (state.calibrationWarning) {
      warningBanner.textContent = `Calibração: ${state.calibrationWarning}`;
      warningBanner.classList.remove('is-hidden');
    } else {
      warningBanner.textContent = '';
      warningBanner.classList.add('is-hidden');
    }

    if (state.errorMessage) {
      errorBanner.textContent = `Erro: ${state.errorMessage}`;
      errorBanner.classList.remove('is-hidden');
    } else {
      errorBanner.textContent = '';
      errorBanner.classList.add('is-hidden');
    }
  }

  function setSearchResults(results: readonly VehicleSummary[], elapsedMs: number): void {
    dropdown.replaceChildren();
    if (results.length === 0) {
      const emptyItem = el('li', 'autocomplete-empty', 'Nenhum veículo encontrado');
      dropdown.append(emptyItem);
      dropdown.classList.remove('is-hidden');
      searchMeta.textContent = `0 resultados (${elapsedMs.toFixed(1)} ms)`;
      return;
    }

    for (const v of results) {
      const item = el('li', 'autocomplete-item');
      item.setAttribute('role', 'option');
      const title = el('span', 'autocomplete-item__title');
      // Escape via textContent (never unescaped HTML)
      title.textContent = `${v.make} ${v.model}`.trim();

      const metaParts: string[] = [];
      if (v.years) metaParts.push(v.years);
      if (v.powerHp !== undefined) metaParts.push(`${v.powerHp} HP`);
      if (v.curbMassKg !== undefined) metaParts.push(`${v.curbMassKg} kg`);
      if (v.drivetrain) metaParts.push(v.drivetrain);
      const sub = el('span', 'autocomplete-item__sub tabular-nums', metaParts.join(' • '));

      item.append(title, sub);
      item.addEventListener('click', () => {
        searchInput.value = `${v.make} ${v.model}`.trim();
        clearVehicleBtn.classList.remove('is-hidden');
        dropdown.classList.add('is-hidden');
        searchMeta.textContent = `Selecionado: #${v.id} (${metaParts.join(' • ')})`;
        callbacks.onSelectVehicle(v);
      });
      dropdown.append(item);
    }

    dropdown.classList.remove('is-hidden');
    searchMeta.textContent = `${results.length} resultados em ${elapsedMs.toFixed(1)} ms`;
  }

  function setProgress(
    stage: WorkerProgressStage | null,
    progress: number,
    message?: string,
  ): void {
    if (!stage || stage === 'ready') {
      progressOverlay.classList.add('is-hidden');
      return;
    }
    const pct = Math.max(0, Math.min(100, Math.round(progress * 100)));
    progressBarFill.style.width = `${pct}%`;
    // Use escapeHtml defensively even though textContent is already safe
    progressText.textContent = message
      ? `${message} (${pct}%)`
      : `${escapeHtml(stage)} (${pct}%)`;
    progressOverlay.classList.remove('is-hidden');
  }

  function setPlaybackState(
    isPlaying: boolean,
    rate: PlaybackRate,
    nextDurationSec: number,
  ): void {
    durationSec = Math.max(0, nextDurationSec);
    const enabled = durationSec > 0;
    playBtn.disabled = !enabled;
    scrubber.disabled = !enabled;
    recordBtn.disabled = !enabled;
    exportSchema6Btn.disabled = !enabled;
    labViewBtn.disabled = !enabled;
    scrubber.max = String(durationSec > 0 ? durationSec : 100);
    playBtn.textContent = isPlaying ? '❚❚' : '▶';
    playBtn.classList.toggle('is-playing', isPlaying);

    for (const [r, btn] of rateButtons.entries()) {
      btn.classList.toggle('is-active', r === rate);
    }
  }

  function setBlackBoxWindow(win: BlackBoxWindow | null): void {
    if (!win || durationSec <= 0) {
      blackboxWindowEl.classList.add('is-hidden');
      return;
    }
    const startPct = Math.max(0, Math.min(100, (win.startSec / durationSec) * 100));
    const endPct = Math.max(startPct, Math.min(100, (win.endSec / durationSec) * 100));
    const widthPct = Math.max(0.8, endPct - startPct);
    const span = Math.max(1e-3, win.endSec - win.startSec);
    const tickPct = Math.max(0, Math.min(100, ((win.incidentSec - win.startSec) / span) * 100));

    blackboxWindowEl.style.left = `${startPct}%`;
    blackboxWindowEl.style.width = `${widthPct}%`;
    blackboxTickEl.style.left = `${tickPct}%`;
    blackboxWindowEl.classList.remove('is-hidden');
  }

  function setRecordingState(recording: boolean, elapsedSec: number): void {
    recordBtn.classList.toggle('is-recording', recording);
    if (recording) {
      const mins = Math.floor(Math.max(0, elapsedSec) / 60);
      const secs = Math.floor(Math.max(0, elapsedSec) % 60);
      const recTime = `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
      recordLabel.textContent = `Parar (REC ${recTime})`;
    } else {
      recordLabel.textContent = 'Gravar Vídeo';
    }
  }

  function setBasemap(mode: BasemapMode): void {
    for (const [m, btn] of basemapButtons.entries()) {
      btn.classList.toggle('is-active', m === mode);
    }
  }

  function updatePlaybackFrame(tSec: number, frame: SampleFrame | null): void {
    if (!isScrubbing) {
      scrubber.value = String(tSec);
    }
    timeDisplay.textContent = `${formatTimeMMSS(tSec)} / ${formatTimeMMSS(durationSec)}`;

    if (!frame) return;

    const speedKmh = frame.speedMs * 3.6;
    const axG = frame.ax / GRAVITY_MS2;
    const ayG = frame.ay / GRAVITY_MS2;
    const kamm = frame.kammIndex;

    pillSpeed.val.textContent = speedKmh.toFixed(1);
    pillKamm.val.textContent = kamm.toFixed(2);
    pillLat.val.textContent = `${ayG >= 0 ? '+' : ''}${ayG.toFixed(2)}`;
    pillLon.val.textContent = `${axG >= 0 ? '+' : ''}${axG.toFixed(2)}`;
    pillGrade.val.textContent = `${frame.roadGradePct >= 0 ? '+' : ''}${frame.roadGradePct.toFixed(1)}`;

    pillKamm.root.classList.toggle('is-danger', kamm > 1.0);
    pillKamm.root.classList.toggle('is-warn', kamm >= 0.75 && kamm <= 1.0);
  }

  function setSelectedVehicleLabel(label: string | null): void {
    if (label) {
      searchInput.value = label;
      clearVehicleBtn.classList.remove('is-hidden');
    } else {
      searchInput.value = '';
      clearVehicleBtn.classList.add('is-hidden');
    }
  }

  function setPayloadInputValue(payloadKg: number): void {
    payloadInput.value = String(Math.round(payloadKg));
  }

  function setCatalogLoadedCount(count: number): void {
    catalogBadge.textContent = `${count.toLocaleString('pt-PT')} veículos`;
  }

  function setOfflineBadge(isOffline: boolean): void {
    offlineBadge.classList.toggle('is-hidden', !isOffline);
  }

  function dispose(): void {
    if (searchDebounceTimer !== null) clearTimeout(searchDebounceTimer);
    if (gripDebounceTimer !== null) clearTimeout(gripDebounceTimer);
    if (payloadDebounceTimer !== null) clearTimeout(payloadDebounceTimer);
    document.removeEventListener('click', handleDocClick);
    window.removeEventListener('dragenter', onDragEnter);
    window.removeEventListener('dragover', onDragOver);
    window.removeEventListener('dragleave', onDragLeave);
    window.removeEventListener('drop', onDrop);
    window.removeEventListener('keydown', onKeyDown);
  }

  return {
    syncState,
    setSearchResults,
    setProgress,
    setPlaybackState,
    setBlackBoxWindow,
    setRecordingState,
    setBasemap,
    updatePlaybackFrame,
    setSelectedVehicleLabel,
    setPayloadInputValue,
    setCatalogLoadedCount,
    setOfflineBadge,
    dispose,
  };
}

function createTelemetryPill(
  label: string,
  initialVal: string,
  unit: string,
): { root: HTMLElement; val: HTMLElement } {
  const root = el('div', 'telemetry-pill');
  const lbl = el('span', 'telemetry-pill__label', label);
  const valRow = el('div', 'telemetry-pill__readout');
  const val = el('span', 'telemetry-pill__val tabular-nums', initialVal);
  const unitEl = el('span', 'telemetry-pill__unit', unit);
  valRow.append(val, unitEl);
  root.append(lbl, valRow);
  return { root, val };
}

function createSummaryCard(
  label: string,
  initialVal: string,
): { root: HTMLElement; val: HTMLElement } {
  const root = el('div', 'summary-card');
  const lbl = el('span', 'summary-card__label', label);
  const val = el('span', 'summary-card__val tabular-nums', initialVal);
  root.append(lbl, val);
  return { root, val };
}
