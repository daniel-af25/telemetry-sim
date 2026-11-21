/**
 * Painel lateral Black Box Incident Replay (`src/ui/blackboxPanel.ts`):
 * - Lista lateral de incidentes (7 categorias) ordenada por severidade (`points DESC`, `excessRatio DESC`).
 * - Filtros rápidos por categoria ou por um dos 5 Pilares de condução (`PILLAR_CATEGORY_MAP`).
 * - Marcadores numerados sincronizados no mapa MapLibre (com persistência entre mudanças de mapa base).
 * - Ação Black Box Jump: salta para `Math.max(0, t - 3.0)`, ativa `cameraMode = 'chase'`,
 *   fixa taxa `0.25x`, inicia `play()` e destaca a janela `[t - 3 s, t + 2 s]` na timeline.
 * - Renderização 100% sanitizada via `textContent` e `escapeHtml()`.
 *
 * Testes:
 *   npx vitest run test/ui/blackboxPanel.test.ts
 */
import type { Feature, FeatureCollection, Point } from 'geojson';
import type * as maplibregl from 'maplibre-gl';
import { PILLAR_CATEGORY_MAP } from '../core/scoring.ts';
import type { Incident, IncidentCategory } from '../core/types.ts';
import type { AppStore } from '../state/appStore.ts';
import type { PlaybackClock } from '../state/playbackClock.ts';
import { escapeHtml } from './sanitize.ts';

const BLACKBOX_PREROLL_SEC = 3.0;
const BLACKBOX_POSTROLL_SEC = 2.0;
const BLACKBOX_REPLAY_RATE = 0.25 as const;

const INCIDENTS_SOURCE_ID = 'blackbox-incidents-src';
const INCIDENTS_LAYER_ID = 'blackbox-incidents-pins';
const PIN_IMAGE_PREFIX = 'bb-pin-';

export const INCIDENT_CATEGORIES: readonly IncidentCategory[] = [
  'braking',
  'lateral',
  'acceleration',
  'combined_brake',
  'combined_traction',
  'bump',
  'slip',
] as const;

export const PILLAR_DISPLAY_NAMES = [
  'CORNERING STABILITY',
  'BRAKING DISCIPLINE',
  'TRACTION CONTROL',
  'CHASSIS CARE',
  'POWERTRAIN SYMPATHY',
] as const;

interface CategoryMeta {
  label: string;
  color: string;
}

const CATEGORY_META: Record<IncidentCategory, CategoryMeta> = {
  braking: { label: 'Travagem', color: '#f43f5e' },
  lateral: { label: 'Lateral', color: '#f59e0b' },
  acceleration: { label: 'Aceleração', color: '#10b981' },
  combined_brake: { label: 'Trail-Brake', color: '#ec4899' },
  combined_traction: { label: 'Tração+Curva', color: '#fb923c' },
  bump: { label: 'Salto/Banda', color: '#a855f7' },
  slip: { label: 'Derrapagem', color: '#ef4444' },
};

const PILLAR_ALIAS_MAP: Record<string, readonly IncidentCategory[]> = {
  cornering: PILLAR_CATEGORY_MAP.cornering,
  'cornering stability': PILLAR_CATEGORY_MAP.cornering,
  braking: PILLAR_CATEGORY_MAP.braking,
  'braking discipline': PILLAR_CATEGORY_MAP.braking,
  traction: PILLAR_CATEGORY_MAP.traction,
  'traction control': PILLAR_CATEGORY_MAP.traction,
  chassis: PILLAR_CATEGORY_MAP.chassis,
  'chassis care': PILLAR_CATEGORY_MAP.chassis,
  powertrain: PILLAR_CATEGORY_MAP.powertrain,
  'powertrain sympathy': PILLAR_CATEGORY_MAP.powertrain,
};

export interface IncidentFilter {
  category?: IncidentCategory | 'all';
  pillar?: string | 'all';
}

export interface BlackBoxWindow {
  startSec: number;
  endSec: number;
  incidentSec: number;
}

export interface IncidentMarkerProperties {
  index: number;
  rank: number;
  category: IncidentCategory;
  color: string;
  iconId: string;
  points: number;
  timeStr: string;
  elapsedSec: number;
  reason: string;
  isActive: boolean;
}

/**
 * Resolves a pillar name or short key (case-insensitive) into its mapped `IncidentCategory` list.
 * Returns `null` for `'all'` or empty input.
 */
export function getCategoriesForPillar(
  pillar: string | undefined,
): readonly IncidentCategory[] | null {
  if (!pillar) return null;
  const normalized = pillar.trim().toLowerCase();
  if (normalized === '' || normalized === 'all') return null;
  return PILLAR_ALIAS_MAP[normalized] ?? [];
}

/**
 * Filters incidents by category and/or Driving Skill Pillar and returns a fresh array
 * sorted by severity (`points DESC`, `excessRatio DESC`, then `elapsedSec ASC`).
 */
export function filterIncidents(
  incidents: readonly Incident[],
  filter: IncidentFilter = {},
): Incident[] {
  const categoryFilter = filter.category && filter.category !== 'all' ? filter.category : null;
  const pillarCategories = getCategoriesForPillar(filter.pillar);

  const filtered = incidents.filter((inc) => {
    if (categoryFilter !== null && inc.category !== categoryFilter) {
      return false;
    }
    if (pillarCategories !== null && !pillarCategories.includes(inc.category)) {
      return false;
    }
    return true;
  });

  filtered.sort((a, b) => {
    if (b.points !== a.points) return b.points - a.points;
    if (b.excessRatio !== a.excessRatio) return b.excessRatio - a.excessRatio;
    return a.elapsedSec - b.elapsedSec;
  });

  return filtered;
}

/**
 * Computes the highlighted `[t - 3 s, t + 2 s]` timeline replay window clamped to `[0, duration]`.
 */
export function computeBlackBoxWindow(
  incidentElapsedSec: number,
  durationSec?: number,
): BlackBoxWindow {
  const safeSec = Number.isFinite(incidentElapsedSec) ? Math.max(0, incidentElapsedSec) : 0;
  const startSec = Math.max(0, safeSec - BLACKBOX_PREROLL_SEC);
  const rawEnd = safeSec + BLACKBOX_POSTROLL_SEC;
  const endSec =
    durationSec !== undefined && Number.isFinite(durationSec) && durationSec > 0
      ? Math.min(durationSec, rawEnd)
      : rawEnd;
  return { startSec, endSec, incidentSec: safeSec };
}

/**
 * Executes the Black Box Jump action on an incident:
 * seeks `clock` to `Math.max(0, incident.elapsedSec - 3.0)`, locks `0.25x` slow-motion,
 * switches `store` camera mode to `'chase'`, and starts playback.
 */
export function triggerBlackBoxJump(
  incident: { elapsedSec: number },
  clock: PlaybackClock,
  store: AppStore,
): void {
  const jumpSec = Math.max(
    0,
    Number.isFinite(incident.elapsedSec) ? incident.elapsedSec - BLACKBOX_PREROLL_SEC : 0,
  );
  clock.setRate(BLACKBOX_REPLAY_RATE);
  store.setState({ cameraMode: 'chase' });
  clock.seek(jumpSec);
  clock.play();
}

function isValidCoord(lat: number | null, lon: number | null): boolean {
  return (
    typeof lat === 'number' &&
    typeof lon === 'number' &&
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    (Math.abs(lat) > 1e-5 || Math.abs(lon) > 1e-5)
  );
}

/**
 * Pure GeoJSON builder for numbered MapLibre incident markers synchronized with the filtered list.
 */
export function buildIncidentsGeoJson(
  incidents: readonly Incident[],
  activeIndex: number = -1,
): FeatureCollection<Point, IncidentMarkerProperties> {
  const features: Array<Feature<Point, IncidentMarkerProperties>> = [];

  for (let i = 0; i < incidents.length; i++) {
    const inc = incidents[i];
    if (!inc || !isValidCoord(inc.lat, inc.lon)) continue;
    const rank = i + 1;
    const isActive = i === activeIndex;
    const meta = CATEGORY_META[inc.category];
    const iconId = `${PIN_IMAGE_PREFIX}${rank}-${inc.category}-${isActive ? '1' : '0'}`;

    features.push({
      type: 'Feature',
      properties: {
        index: i,
        rank,
        category: inc.category,
        color: meta.color,
        iconId,
        points: inc.points,
        timeStr: escapeHtml(inc.timeStr),
        elapsedSec: inc.elapsedSec,
        reason: escapeHtml(inc.reason),
        isActive,
      },
      geometry: {
        type: 'Point',
        coordinates: [inc.lon!, inc.lat!],
      },
    });
  }

  return { type: 'FeatureCollection', features };
}

function createNumberedPinImage(
  rank: number,
  fillColor: string,
  isActive: boolean,
): ImageData | null {
  if (typeof document === 'undefined') return null;
  const size = 56;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  const cx = size / 2;
  const cy = size / 2;
  const radius = isActive ? 21 : 17;

  ctx.clearRect(0, 0, size, size);

  if (isActive) {
    ctx.beginPath();
    ctx.arc(cx, cy, 25, 0, Math.PI * 2);
    ctx.fillStyle = 'rgba(56, 189, 248, 0.35)';
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.fillStyle = fillColor;
  ctx.fill();

  ctx.lineWidth = isActive ? 3.5 : 2.5;
  ctx.strokeStyle = isActive ? '#38bdf8' : '#f8fafc';
  ctx.stroke();

  ctx.fillStyle = '#ffffff';
  ctx.font = `800 ${rank >= 100 ? 13 : rank >= 10 ? 15 : 17}px ui-monospace, SFMono-Regular, monospace`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(rank), cx, cy + 1);

  return ctx.getImageData(0, 0, size, size);
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

export interface BlackboxPanelOptions {
  container: HTMLElement;
  clock: PlaybackClock;
  store: AppStore;
  map?: maplibregl.Map;
  onBlackBoxJump?: (incident: Incident, window: BlackBoxWindow, rank: number) => void;
  onExportSchema6?: (incident: Incident, rank: number) => void;
}

export interface BlackboxPanelController {
  setIncidents(incidents: readonly Incident[]): void;
  setFilter(filter: IncidentFilter): void;
  syncMapLayers(map?: maplibregl.Map): void;
  clearSelection(): void;
  dispose(): void;
}

/**
 * Creates the collapsible right-side Black Box Incident Replay panel, synchronized with
 * numbered MapLibre markers and 0.25x Chase Black Box Jump playback.
 */
export function createBlackboxPanel(
  options: BlackboxPanelOptions,
): BlackboxPanelController {
  const { container, clock, store } = options;
  let mapRef: maplibregl.Map | null = options.map ?? null;

  let allIncidents: Incident[] = [];
  let filteredIncidents: Incident[] = [];
  let activeFilter: IncidentFilter = { category: 'all', pillar: 'all' };
  let activeFilteredIndex = -1;
  let mapListenersBound = false;

  // -------------------------------------------------------------------------
  // DOM Structure (100% textContent / sanitized)
  // -------------------------------------------------------------------------
  const shell = el('div', 'blackbox-shell is-collapsed');

  const toggleBtn = el('button', 'blackbox-toggle glass-panel');
  toggleBtn.type = 'button';
  toggleBtn.title = 'Abrir / recolher lista de incidentes Black Box';
  toggleBtn.setAttribute('aria-expanded', 'false');
  const toggleArrow = el('span', 'blackbox-toggle__arrow', '◀');
  const toggleLabel = el('span', 'blackbox-toggle__label', 'BLACK BOX');
  const toggleCount = el('span', 'blackbox-toggle__count tabular-nums', '0');
  toggleBtn.append(toggleArrow, toggleLabel, toggleCount);

  const panel = el('aside', 'blackbox-panel glass-panel');
  panel.setAttribute('aria-label', 'Lista de incidentes Black Box');

  const header = el('div', 'blackbox-header');
  const titleWrap = el('div', 'section-row');
  titleWrap.append(el('h2', 'panel-heading', 'BLACK BOX · INCIDENTES'));
  const countBadge = el('span', 'micro-badge tabular-nums', '0 incidentes');
  titleWrap.append(countBadge);
  header.append(titleWrap);

  // Unified filter dropdown (All + 5 Pillars + 7 Categories — mutually exclusive, zero duplication)
  const filterSelect = el('select', 'telemetry-select blackbox-select');
  filterSelect.setAttribute('aria-label', 'Filtrar incidentes por pilar ou categoria');

  const allOpt = document.createElement('option');
  allOpt.value = 'all';
  allOpt.textContent = 'Todos os incidentes';
  filterSelect.append(allOpt);

  const pillarGroup = document.createElement('optgroup');
  pillarGroup.label = 'Por Pilar (5)';
  for (const pillarName of PILLAR_DISPLAY_NAMES) {
    const opt = document.createElement('option');
    opt.value = `pillar:${pillarName}`;
    opt.textContent = pillarName;
    pillarGroup.append(opt);
  }
  filterSelect.append(pillarGroup);

  const categoryGroup = document.createElement('optgroup');
  categoryGroup.label = 'Por Categoria (7)';
  for (const cat of INCIDENT_CATEGORIES) {
    const opt = document.createElement('option');
    opt.value = `category:${cat}`;
    opt.textContent = CATEGORY_META[cat].label;
    categoryGroup.append(opt);
  }
  filterSelect.append(categoryGroup);

  filterSelect.addEventListener('change', () => {
    const val = filterSelect.value;
    if (val.startsWith('pillar:')) {
      activeFilter = { category: 'all', pillar: val.slice('pillar:'.length) };
    } else if (val.startsWith('category:')) {
      activeFilter = {
        category: val.slice('category:'.length) as IncidentCategory,
        pillar: 'all',
      };
    } else {
      activeFilter = { category: 'all', pillar: 'all' };
    }
    activeFilteredIndex = -1;
    applyFilterAndRender();
  });

  const listEl = el('ul', 'blackbox-list');
  const emptyEl = el('div', 'blackbox-empty', 'Sem incidentes para o filtro atual.');

  panel.append(header, filterSelect, listEl, emptyEl);
  shell.append(toggleBtn, panel);
  container.append(shell);

  function setCollapsed(collapsed: boolean): void {
    shell.classList.toggle('is-collapsed', collapsed);
    toggleArrow.textContent = collapsed ? '◀' : '▶';
    toggleBtn.setAttribute('aria-expanded', String(!collapsed));
  }

  toggleBtn.addEventListener('click', () => {
    const nextCollapsed = !shell.classList.contains('is-collapsed');
    setCollapsed(nextCollapsed);
  });

  // -------------------------------------------------------------------------
  // MapLibre Numbered Markers Synchronization
  // -------------------------------------------------------------------------
  const onPinClick = (e: maplibregl.MapLayerMouseEvent) => {
    const feature = e.features?.[0];
    const idxRaw = feature?.properties?.['index'];
    const idx = typeof idxRaw === 'number' ? idxRaw : Number(idxRaw);
    if (Number.isInteger(idx) && idx >= 0 && idx < filteredIncidents.length) {
      selectAndJump(idx);
    }
  };

  const onPinMouseEnter = () => {
    if (mapRef) mapRef.getCanvas().style.cursor = 'pointer';
  };

  const onPinMouseLeave = () => {
    if (mapRef) mapRef.getCanvas().style.cursor = '';
  };

  function bindMapListeners(map: maplibregl.Map): void {
    if (mapListenersBound) return;
    map.on('click', INCIDENTS_LAYER_ID, onPinClick);
    map.on('mouseenter', INCIDENTS_LAYER_ID, onPinMouseEnter);
    map.on('mouseleave', INCIDENTS_LAYER_ID, onPinMouseLeave);
    mapListenersBound = true;
  }

  function unbindMapListeners(map: maplibregl.Map): void {
    if (!mapListenersBound) return;
    map.off('click', INCIDENTS_LAYER_ID, onPinClick);
    map.off('mouseenter', INCIDENTS_LAYER_ID, onPinMouseEnter);
    map.off('mouseleave', INCIDENTS_LAYER_ID, onPinMouseLeave);
    mapListenersBound = false;
  }

  function syncMapLayers(nextMap?: maplibregl.Map): void {
    if (nextMap) mapRef = nextMap;
    const map = mapRef;
    if (!map) return;

    try {
      if (!map.isStyleLoaded() && !map.getStyle()) return;
    } catch {
      return;
    }

    const geojson = buildIncidentsGeoJson(filteredIncidents, activeFilteredIndex);

    // Register numbered pin images dynamically (zero external font/glyph dependency)
    for (const feature of geojson.features) {
      const props = feature.properties;
      if (!map.hasImage(props.iconId)) {
        const img = createNumberedPinImage(props.rank, props.color, props.isActive);
        if (img) {
          map.addImage(props.iconId, img, { pixelRatio: 2 });
        }
      }
    }

    try {
      const existingSrc = map.getSource(INCIDENTS_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      if (existingSrc) {
        existingSrc.setData(geojson);
      } else {
        map.addSource(INCIDENTS_SOURCE_ID, {
          type: 'geojson',
          data: geojson,
        });
      }

      if (!map.getLayer(INCIDENTS_LAYER_ID)) {
        map.addLayer({
          id: INCIDENTS_LAYER_ID,
          type: 'symbol',
          source: INCIDENTS_SOURCE_ID,
          layout: {
            'icon-image': ['get', 'iconId'],
            'icon-size': ['case', ['boolean', ['get', 'isActive'], false], 1.15, 0.92],
            'icon-allow-overlap': true,
            'icon-ignore-placement': true,
          },
        });
      }

      bindMapListeners(map);
    } catch {
      // Style may be mid-transition; next style.load will invoke syncMapLayers
    }
  }

  // -------------------------------------------------------------------------
  // List Rendering & Black Box Jump
  // -------------------------------------------------------------------------
  function selectAndJump(filteredIndex: number): void {
    const incident = filteredIncidents[filteredIndex];
    if (!incident) return;

    activeFilteredIndex = filteredIndex;
    renderList();
    syncMapLayers();

    triggerBlackBoxJump(incident, clock, store);
    const window = computeBlackBoxWindow(incident.elapsedSec, clock.getDurationSec());
    options.onBlackBoxJump?.(incident, window, filteredIndex + 1);
  }

  function renderList(): void {
    listEl.replaceChildren();
    const total = allIncidents.length;
    const shown = filteredIncidents.length;

    toggleCount.textContent = String(total);
    toggleCount.classList.toggle('has-incidents', total > 0);
    countBadge.textContent =
      shown === total
        ? `${total} ${total === 1 ? 'incidente' : 'incidentes'}`
        : `${shown} / ${total}`;

    emptyEl.classList.toggle('is-hidden', shown > 0);

    for (let i = 0; i < shown; i++) {
      const inc = filteredIncidents[i];
      if (!inc) continue;
      const meta = CATEGORY_META[inc.category];
      const rank = i + 1;

      const li = el('li', 'blackbox-item');
      const btn = el('button', 'blackbox-card');
      btn.type = 'button';
      if (i === activeFilteredIndex) {
        btn.classList.add('is-active');
      }

      const topRow = el('div', 'blackbox-card__top');
      const rankBadge = el('span', 'blackbox-rank tabular-nums', `#${rank}`);
      rankBadge.style.backgroundColor = meta.color;

      const catTag = el('span', 'blackbox-cat', meta.label);
      const timeTag = el('span', 'blackbox-time tabular-nums', inc.timeStr);
      const ptsTag = el('span', 'blackbox-pts tabular-nums', `-${inc.points} pts`);
      topRow.append(rankBadge, catTag, timeTag, ptsTag);

      // Sanitized via textContent (zero raw innerHTML)
      const reasonEl = el('div', 'blackbox-card__reason', inc.reason);
      const metaRow = el('div', 'blackbox-card__meta');
      metaRow.append(
        el('span', 'blackbox-intensity tabular-nums', inc.intensity),
        el('span', 'blackbox-jump-hint', 'Replay 0.25× ▸'),
      );

      btn.append(topRow, reasonEl, metaRow);
      btn.addEventListener('click', () => selectAndJump(i));
      li.append(btn);

      if (options.onExportSchema6) {
        const exportBtn = el(
          'button',
          'blackbox-export-btn',
          'Exportar Recorte # schema=6 (10–20 s)',
        );
        exportBtn.type = 'button';
        exportBtn.title = 'Descarregar CSV científico # schema=6 (16 s centrados neste incidente) para view3d.py / topdown.py';
        exportBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          options.onExportSchema6?.(inc, rank);
        });
        li.append(exportBtn);
      }

      listEl.append(li);
    }
  }

  function applyFilterAndRender(): void {
    filteredIncidents = filterIncidents(allIncidents, activeFilter);
    renderList();
    syncMapLayers();
  }

  function setIncidents(incidents: readonly Incident[]): void {
    allIncidents = [...incidents];
    activeFilteredIndex = -1;
    applyFilterAndRender();
    // Auto-expand when incidents are detected so the driver immediately sees them
    if (allIncidents.length > 0) {
      setCollapsed(false);
    } else {
      setCollapsed(true);
    }
  }

  function setFilter(filter: IncidentFilter): void {
    activeFilter = {
      category: filter.category ?? 'all',
      pillar: filter.pillar ?? 'all',
    };
    activeFilteredIndex = -1;
    if (activeFilter.category && activeFilter.category !== 'all') {
      filterSelect.value = `category:${activeFilter.category}`;
    } else if (activeFilter.pillar && activeFilter.pillar !== 'all') {
      filterSelect.value = `pillar:${activeFilter.pillar.trim().toUpperCase()}`;
    } else {
      filterSelect.value = 'all';
    }
    applyFilterAndRender();
  }

  function clearSelection(): void {
    activeFilteredIndex = -1;
    renderList();
    syncMapLayers();
  }

  function dispose(): void {
    if (mapRef) {
      unbindMapListeners(mapRef);
      try {
        if (mapRef.getLayer(INCIDENTS_LAYER_ID)) mapRef.removeLayer(INCIDENTS_LAYER_ID);
        if (mapRef.getSource(INCIDENTS_SOURCE_ID)) mapRef.removeSource(INCIDENTS_SOURCE_ID);
      } catch {
        // Map already destroyed
      }
      mapRef = null;
    }
    shell.remove();
  }

  return {
    setIncidents,
    setFilter,
    syncMapLayers,
    clearSelection,
    dispose,
  };
}
