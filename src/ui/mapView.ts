/**
 * Componente de mapa MapLibre GL 2D/3D com 3 mapas base gratuitos (Escuro 3D, Satélite 3D
 * Esri World Imagery, Vetorial OpenFreeMap Liberty), terreno 3D DEM (AWS Terrarium),
 * edifícios 3D extrudidos (`fill-extrusion`), hillshade, luz e céu atmosférico,
 * fallback resiliente offline, Telemetry Ribbon quantizado (`RdYlGn_r`), camada
 * tracejada para túneis (`IS_TUNNEL_DR`) e marcador animado do veículo a 60 FPS.
 *
 * Testes:
 *   npx vitest run test/ui/mapView.test.ts
 */
import * as maplibregl from 'maplibre-gl';
import maplibreWorkerUrl from 'maplibre-gl/dist/maplibre-gl-worker.mjs?url';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { SampleFrame } from '../core/interpolator.ts';
import { TRACK_FLAG, type TelemetryTrackSoA } from '../core/soa.ts';
import type { CameraMode, RibbonMetric } from '../state/appStore.ts';

const GRAVITY_MS2 = 9.80665;
const RAD_TO_DEG = 180 / Math.PI;

const DEFAULT_CENTER: [number, number] = [-8.611, 41.1579]; // Porto, Portugal
const DEFAULT_ZOOM = 12;
const MIN_3D_ZOOM = 14.8;

export type BasemapMode = 'dark' | 'satellite' | 'liberty';

const CARTO_DARK_STYLE_URL =
  'https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json';
const OPENFREEMAP_LIBERTY_STYLE_URL =
  'https://tiles.openfreemap.org/styles/liberty';
const OPENFREEMAP_PLANET_URL = 'https://tiles.openfreemap.org/planet';
const OPENFREEMAP_GLYPHS_URL =
  'https://tiles.openfreemap.org/fonts/{fontstack}/{range}.pbf';
const ESRI_SATELLITE_TILES = [
  'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{x}/{y}',
];

const TERRARIUM_SOURCE_ID = 'terrarium-dem';
const TERRARIUM_HILLSHADE_SOURCE_ID = 'terrarium-hillshade-src';
const TERRARIUM_HILLSHADE_LAYER_ID = 'terrarium-hillshade';
const TERRARIUM_TILES = [
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
];

const BUILDINGS_SOURCE_ID = 'openfreemap-buildings';
const BUILDINGS_LAYER_ID = '3d-buildings-extrusion';

const RIBBON_SOURCE_ID = 'telemetry-ribbon-src';
const RIBBON_GLOW_LAYER_ID = 'telemetry-ribbon-glow';
const RIBBON_LAYER_ID = 'telemetry-ribbon-line';
const TUNNEL_SOURCE_ID = 'telemetry-tunnel-src';
const TUNNEL_LAYER_ID = 'telemetry-tunnel-line';
const VEHICLE_SOURCE_ID = 'telemetry-vehicle-src';
const VEHICLE_HALO_LAYER_ID = 'telemetry-vehicle-halo';
const VEHICLE_DOT_LAYER_ID = 'telemetry-vehicle-dot';
const VEHICLE_ARROW_LAYER_ID = 'telemetry-vehicle-arrow';
const VEHICLE_ARROW_IMAGE_ID = 'telemetry-vehicle-chevron';

const STYLE_LOAD_TIMEOUT_MS = 5000;
const RIBBON_BINS = 24;

export interface RibbonMetricMeta {
  key: RibbonMetric;
  label: string;
  unit: string;
  min: number;
  max: number;
}

const RIBBON_METRIC_META: Record<RibbonMetric, RibbonMetricMeta> = {
  kammIndex: { key: 'kammIndex', label: 'Kamm Index', unit: '×', min: 0, max: 1.2 },
  speed: { key: 'speed', label: 'Speed', unit: 'km/h', min: 0, max: 120 },
  ay: { key: 'ay', label: 'Lateral |ay|', unit: 'G', min: 0, max: 0.8 },
  ax: { key: 'ax', label: 'Longitudinal |ax|', unit: 'G', min: 0, max: 0.8 },
  roadGradePct: { key: 'roadGradePct', label: 'Road Grade', unit: '%', min: 0, max: 12 },
};

const RDYLGN_R_ANCHORS: ReadonlyArray<readonly [number, number, number]> = [
  [16, 185, 129],  // #10b981 emerald green (low)
  [132, 204, 22],  // #84cc16 lime
  [250, 204, 21],  // #facc15 yellow (mid)
  [249, 115, 22],  // #f97316 orange
  [244, 63, 94],   // #f43f5e crimson red (high)
];

function buildRdYlGnRPalette(steps: number): readonly string[] {
  const palette: string[] = [];
  const segments = RDYLGN_R_ANCHORS.length - 1;

  for (let i = 0; i < steps; i++) {
    const t = steps > 1 ? i / (steps - 1) : 0;
    const scaled = t * segments;
    const idx = Math.min(segments - 1, Math.floor(scaled));
    const localT = scaled - idx;

    const c0 = RDYLGN_R_ANCHORS[idx] ?? RDYLGN_R_ANCHORS[0]!;
    const c1 = RDYLGN_R_ANCHORS[idx + 1] ?? c0;

    const r = Math.round(c0[0] + (c1[0] - c0[0]) * localT);
    const g = Math.round(c0[1] + (c1[1] - c0[1]) * localT);
    const b = Math.round(c0[2] + (c1[2] - c0[2]) * localT);

    palette.push(
      `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`,
    );
  }

  return palette;
}

export const RDYLGN_R_PALETTE: readonly string[] = buildRdYlGnRPalette(RIBBON_BINS);

export function getRibbonMetricMeta(metricKey: RibbonMetric): RibbonMetricMeta {
  return RIBBON_METRIC_META[metricKey];
}

export interface RibbonSegmentProperties {
  color: string;
  bin: number;
  value: number;
}

export interface TunnelSegmentProperties {
  isTunnel: true;
}

export interface TelemetryRibbonGeoJson {
  ribbon: FeatureCollection<LineString, RibbonSegmentProperties>;
  tunnels: FeatureCollection<LineString, TunnelSegmentProperties>;
  bounds: [[number, number], [number, number]] | null;
}

function sampleMetricValue(
  soa: TelemetryTrackSoA,
  idx: number,
  metricKey: RibbonMetric,
): number {
  switch (metricKey) {
    case 'kammIndex':
      return soa.kammIndex[idx] ?? 0;
    case 'speed':
      return (soa.speedMs[idx] ?? 0) * 3.6;
    case 'ay':
      return Math.abs(soa.ay[idx] ?? 0) / GRAVITY_MS2;
    case 'ax':
      return Math.abs(soa.ax[idx] ?? 0) / GRAVITY_MS2;
    case 'roadGradePct':
      return Math.abs(soa.roadGradePct[idx] ?? 0);
  }
}

function quantizeMetricBin(value: number, meta: RibbonMetricMeta): number {
  const span = meta.max - meta.min;
  if (span <= 0 || !Number.isFinite(value)) return 0;
  const norm = Math.max(0, Math.min(1, (value - meta.min) / span));
  return Math.min(
    RDYLGN_R_PALETTE.length - 1,
    Math.floor(norm * (RDYLGN_R_PALETTE.length - 1) + 1e-9),
  );
}

function isValidLatLon(lat: number, lon: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lon) &&
    Math.abs(lat) <= 90 &&
    Math.abs(lon) <= 180 &&
    (Math.abs(lat) > 1e-5 || Math.abs(lon) > 1e-5)
  );
}

/**
 * Pure GeoJSON builder for the Telemetry Ribbon (`RdYlGn_r` quantized segments)
 * and dashed tunnel dead-reckoning segments (`TRACK_FLAG.IS_TUNNEL_DR`).
 * Merges consecutive segments sharing the same color bin while preserving peaks
 * and splitting strictly across temporal gaps (`TRACK_FLAG.IS_GAP`).
 */
export function buildTelemetryRibbonGeoJson(
  soa: TelemetryTrackSoA,
  metricKey: RibbonMetric,
): TelemetryRibbonGeoJson {
  const ribbonFeatures: Array<Feature<LineString, RibbonSegmentProperties>> = [];
  const tunnelFeatures: Array<Feature<LineString, TunnelSegmentProperties>> = [];
  const meta = RIBBON_METRIC_META[metricKey];

  let minLon = Infinity;
  let minLat = Infinity;
  let maxLon = -Infinity;
  let maxLat = -Infinity;

  let activeRibbonCoords: Array<[number, number]> | null = null;
  let activeRibbonBin = -1;
  let activeRibbonPeak = 0;

  let activeTunnelCoords: Array<[number, number]> | null = null;

  const flushRibbon = () => {
    if (activeRibbonCoords && activeRibbonCoords.length >= 2 && activeRibbonBin >= 0) {
      ribbonFeatures.push({
        type: 'Feature',
        properties: {
          bin: activeRibbonBin,
          color: RDYLGN_R_PALETTE[activeRibbonBin] ?? RDYLGN_R_PALETTE[0]!,
          value: activeRibbonPeak,
        },
        geometry: {
          type: 'LineString',
          coordinates: activeRibbonCoords,
        },
      });
    }
    activeRibbonCoords = null;
    activeRibbonBin = -1;
    activeRibbonPeak = 0;
  };

  const flushTunnel = () => {
    if (activeTunnelCoords && activeTunnelCoords.length >= 2) {
      tunnelFeatures.push({
        type: 'Feature',
        properties: { isTunnel: true },
        geometry: {
          type: 'LineString',
          coordinates: activeTunnelCoords,
        },
      });
    }
    activeTunnelCoords = null;
  };

  const n = soa.length;
  for (let i = 0; i < n; i++) {
    const lat = soa.lat[i] ?? Number.NaN;
    const lon = soa.lon[i] ?? Number.NaN;
    if (isValidLatLon(lat, lon)) {
      if (lon < minLon) minLon = lon;
      if (lon > maxLon) maxLon = lon;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }

  for (let i = 0; i < n - 1; i++) {
    const lat0 = soa.lat[i] ?? Number.NaN;
    const lon0 = soa.lon[i] ?? Number.NaN;
    const lat1 = soa.lat[i + 1] ?? Number.NaN;
    const lon1 = soa.lon[i + 1] ?? Number.NaN;
    const flags0 = soa.flags[i] ?? 0;
    const flags1 = soa.flags[i + 1] ?? 0;

    const isGap = (flags1 & TRACK_FLAG.IS_GAP) !== 0;
    if (isGap || !isValidLatLon(lat0, lon0) || !isValidLatLon(lat1, lon1)) {
      flushRibbon();
      flushTunnel();
      continue;
    }

    const isTunnel = ((flags0 | flags1) & TRACK_FLAG.IS_TUNNEL_DR) !== 0;

    if (isTunnel) {
      flushRibbon();
      if (!activeTunnelCoords) {
        activeTunnelCoords = [
          [lon0, lat0],
          [lon1, lat1],
        ];
      } else {
        activeTunnelCoords.push([lon1, lat1]);
      }
      continue;
    }

    flushTunnel();

    // Preserve peaks by taking the maximum of segment endpoints
    const v0 = sampleMetricValue(soa, i, metricKey);
    const v1 = sampleMetricValue(soa, i + 1, metricKey);
    const segVal = Math.max(v0, v1);
    const bin = quantizeMetricBin(segVal, meta);

    if (activeRibbonCoords && activeRibbonBin === bin) {
      activeRibbonCoords.push([lon1, lat1]);
      if (segVal > activeRibbonPeak) activeRibbonPeak = segVal;
    } else {
      flushRibbon();
      activeRibbonBin = bin;
      activeRibbonPeak = segVal;
      activeRibbonCoords = [
        [lon0, lat0],
        [lon1, lat1],
      ];
    }
  }

  flushRibbon();
  flushTunnel();

  const bounds: [[number, number], [number, number]] | null =
    Number.isFinite(minLon) && Number.isFinite(minLat)
      ? [
          [minLon, minLat],
          [maxLon, maxLat],
        ]
      : null;

  return {
    ribbon: { type: 'FeatureCollection', features: ribbonFeatures },
    tunnels: { type: 'FeatureCollection', features: tunnelFeatures },
    bounds,
  };
}

const OFFLINE_DARK_STYLE: maplibregl.StyleSpecification = {
  version: 8,
  name: 'Telemetry Offline Dark',
  sources: {},
  layers: [
    {
      id: 'offline-background',
      type: 'background',
      paint: {
        'background-color': '#070c18',
      },
    },
  ],
};

function createSatelliteStyle(): maplibregl.StyleSpecification {
  return {
    version: 8,
    name: 'Telemetry Satellite 3D (Esri + OpenFreeMap)',
    glyphs: OPENFREEMAP_GLYPHS_URL,
    sources: {
      'esri-satellite': {
        type: 'raster',
        tiles: ESRI_SATELLITE_TILES,
        tileSize: 256,
        maxzoom: 19,
        attribution: '© Esri, Maxar, Earthstar Geographics',
      },
      [BUILDINGS_SOURCE_ID]: {
        type: 'vector',
        url: OPENFREEMAP_PLANET_URL,
      },
    },
    layers: [
      {
        id: 'satellite-bg',
        type: 'background',
        paint: { 'background-color': '#070c18' },
      },
      {
        id: 'esri-satellite-layer',
        type: 'raster',
        source: 'esri-satellite',
        paint: {
          'raster-fade-duration': 150,
          'raster-contrast': 0.06,
          'raster-saturation': 0.08,
        },
      },
      {
        id: 'satellite-road-labels',
        type: 'symbol',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': 'transportation_name',
        minzoom: 13,
        layout: {
          'symbol-placement': 'line',
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Noto Sans Regular'],
          'text-size': 11,
          'text-max-angle': 30,
        },
        paint: {
          'text-color': '#f8fafc',
          'text-halo-color': 'rgba(7, 12, 24, 0.85)',
          'text-halo-width': 1.5,
        },
      },
      {
        id: 'satellite-place-labels',
        type: 'symbol',
        source: BUILDINGS_SOURCE_ID,
        'source-layer': 'place',
        minzoom: 9,
        layout: {
          'text-field': ['coalesce', ['get', 'name:latin'], ['get', 'name']],
          'text-font': ['Noto Sans Bold'],
          'text-size': ['interpolate', ['linear'], ['zoom'], 9, 11, 14, 15],
        },
        paint: {
          'text-color': '#f8fafc',
          'text-halo-color': 'rgba(7, 12, 24, 0.9)',
          'text-halo-width': 1.8,
        },
      },
    ],
  };
}

function getStyleForBasemap(
  mode: BasemapMode,
): string | maplibregl.StyleSpecification {
  switch (mode) {
    case 'dark':
      return CARTO_DARK_STYLE_URL;
    case 'satellite':
      return createSatelliteStyle();
    case 'liberty':
      return OPENFREEMAP_LIBERTY_STYLE_URL;
  }
}

function getBuildingPaintForBasemap(
  mode: BasemapMode,
): maplibregl.FillExtrusionLayerSpecification['paint'] {
  if (mode === 'satellite') {
    return {
      'fill-extrusion-color': '#cbd5e1',
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.38,
      'fill-extrusion-vertical-gradient': true,
    };
  }
  if (mode === 'liberty') {
    return {
      'fill-extrusion-color': [
        'interpolate',
        ['linear'],
        ['coalesce', ['get', 'render_height'], 10],
        0,
        '#cbd5e1',
        25,
        '#94a3b8',
        70,
        '#64748b',
      ],
      'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
      'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
      'fill-extrusion-opacity': 0.85,
      'fill-extrusion-vertical-gradient': true,
    };
  }
  // 'dark' metallic slate gradient
  return {
    'fill-extrusion-color': [
      'interpolate',
      ['linear'],
      ['coalesce', ['get', 'render_height'], 10],
      0,
      '#1e293b',
      25,
      '#334155',
      70,
      '#475569',
    ],
    'fill-extrusion-height': ['coalesce', ['get', 'render_height'], 10],
    'fill-extrusion-base': ['coalesce', ['get', 'render_min_height'], 0],
    'fill-extrusion-opacity': 0.88,
    'fill-extrusion-vertical-gradient': true,
  };
}

function getSkyForBasemap(mode: BasemapMode): maplibregl.SkySpecification {
  if (mode === 'dark') {
    return {
      'sky-color': '#0c1938',
      'horizon-color': '#1e3a5f',
      'fog-color': '#0b1120',
      'sky-horizon-blend': 0.5,
      'horizon-fog-blend': 0.7,
      'fog-ground-blend': 0.55,
      'atmosphere-blend': 0.85,
    };
  }
  // Realistic daylight sky atmosphere for satellite & liberty
  return {
    'sky-color': '#2563eb',
    'horizon-color': '#93c5fd',
    'fog-color': '#dbeafe',
    'sky-horizon-blend': 0.55,
    'horizon-fog-blend': 0.7,
    'fog-ground-blend': 0.45,
    'atmosphere-blend': 0.85,
  };
}

function emptyLineCollection(): FeatureCollection<LineString> {
  return { type: 'FeatureCollection', features: [] };
}

function createVehicleChevronImage(): ImageData | null {
  if (typeof document === 'undefined') return null;
  const size = 48;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (!ctx) return null;

  ctx.clearRect(0, 0, size, size);
  ctx.save();
  ctx.translate(size / 2, size / 2);

  // Crisp upward-pointing navigation chevron (bearing 0 = North)
  ctx.beginPath();
  ctx.moveTo(0, -17);
  ctx.lineTo(12, 13);
  ctx.lineTo(0, 6);
  ctx.lineTo(-12, 13);
  ctx.closePath();

  ctx.fillStyle = '#38bdf8';
  ctx.fill();
  ctx.lineWidth = 2.5;
  ctx.strokeStyle = '#f8fafc';
  ctx.stroke();
  ctx.restore();

  return ctx.getImageData(0, 0, size, size);
}

export interface MapViewOptions {
  initial3D?: boolean;
  initialBasemap?: BasemapMode;
  externalCameraControl?: boolean;
  onStyleLoad?: (map: maplibregl.Map) => void;
  onOfflineFallback?: (isOffline: boolean) => void;
}

export interface MapViewController {
  getMap(): maplibregl.Map;
  renderTelemetryRibbon(
    soa: TelemetryTrackSoA,
    metricKey: RibbonMetric,
    fitToTrack?: boolean,
  ): void;
  updateVehiclePose(frame: SampleFrame): void;
  setVehicleMarkerVisible(visible: boolean): void;
  clearTrack(): void;
  set3DMode(enabled: boolean): void;
  setBasemap(mode: BasemapMode): void;
  getBasemap(): BasemapMode;
  setCameraMode(mode: CameraMode): void;
  fitToCurrentTrack(): void;
  dispose(): void;
}

/**
 * Instantiates and manages the MapLibre GL 2D/3D map, 3 free basemaps, AWS Terrarium
 * DEM terrain + hillshade, 3D extruded OpenFreeMap buildings, sky/light atmosphere,
 * resilient offline fallback, Telemetry Ribbon, tunnel layer, and 60 FPS vehicle pose.
 */
export function createMapView(
  container: HTMLElement,
  options: MapViewOptions = {},
): MapViewController {
  // Register self-contained MapLibre v6 worker URL before instantiating Map (Vite 8 compatibility)
  if (typeof window !== 'undefined' && typeof maplibregl.setWorkerUrl === 'function') {
    maplibregl.setWorkerUrl(maplibreWorkerUrl);
  }

  let is3D = options.initial3D ?? true;
  let basemapMode: BasemapMode = options.initialBasemap ?? 'dark';
  let cameraMode: CameraMode = 'chase';
  let offlineFallbackActive =
    typeof navigator !== 'undefined' && navigator.onLine === false;
  let styleLoaded = false;
  let styleWatchdog: ReturnType<typeof setTimeout> | null = null;
  let lastRibbonData: TelemetryRibbonGeoJson | null = null;
  let lastFitBounds: [[number, number], [number, number]] | null = null;
  let pendingFitOnStyleLoad = false;
  let hasVehiclePose = false;
  let vehicleMarkerVisible = true;
  const externalCameraControl = Boolean(options.externalCameraControl);

  // Reusable single-object GeoJSON payload for zero-allocation 60 FPS updates
  const vehicleCoord: [number, number] = [DEFAULT_CENTER[0], DEFAULT_CENTER[1]];
  const vehicleFeature: Feature<Point, { bearing: number; speedKmh: number }> = {
    type: 'Feature',
    properties: { bearing: 0, speedKmh: 0 },
    geometry: {
      type: 'Point',
      coordinates: vehicleCoord,
    },
  };
  const vehicleCollection: FeatureCollection<Point, { bearing: number; speedKmh: number }> = {
    type: 'FeatureCollection',
    features: [],
  };

  const initialStyle: string | maplibregl.StyleSpecification = offlineFallbackActive
    ? OFFLINE_DARK_STYLE
    : getStyleForBasemap(basemapMode);

  const map = new maplibregl.Map({
    container,
    style: initialStyle,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    pitch: is3D ? 65 : 0,
    bearing: 0,
    maxPitch: 85,
    attributionControl: { compact: true },
    canvasContextAttributes: {
      antialias: true,
      powerPreference: 'high-performance',
      preserveDrawingBuffer: true,
    },
  });

  map.addControl(
    new maplibregl.NavigationControl({ visualizePitch: true }),
    'top-right',
  );
  map.addControl(new maplibregl.ScaleControl({ unit: 'metric' }), 'bottom-right');

  function clearWatchdog(): void {
    if (styleWatchdog !== null) {
      clearTimeout(styleWatchdog);
      styleWatchdog = null;
    }
  }

  function triggerOfflineFallback(): void {
    clearWatchdog();
    if (offlineFallbackActive) return;

    styleLoaded = false;
    offlineFallbackActive = true;
    options.onOfflineFallback?.(true);
    map.setStyle(OFFLINE_DARK_STYLE);
  }

  function armWatchdog(): void {
    clearWatchdog();
    if (offlineFallbackActive) return;
    styleWatchdog = setTimeout(() => {
      if (!styleLoaded) {
        triggerOfflineFallback();
      }
    }, STYLE_LOAD_TIMEOUT_MS);
  }

  armWatchdog();

  if (offlineFallbackActive) {
    options.onOfflineFallback?.(true);
  }

  function setLayerVisibilitySafe(layerId: string, visible: boolean): void {
    try {
      if (map.getLayer(layerId)) {
        map.setLayoutProperty(layerId, 'visibility', visible ? 'visible' : 'none');
      }
    } catch {
      // Ignore if layer is mid-transition
    }
  }

  function apply3DEnvironment(): void {
    if (!styleLoaded) return;

    const enable3DEffects = is3D && !offlineFallbackActive;

    // 1. Toggle 3D buildings & hillshade layers (plus any native Liberty 3D building layer)
    setLayerVisibilitySafe(BUILDINGS_LAYER_ID, enable3DEffects);
    setLayerVisibilitySafe(TERRARIUM_HILLSHADE_LAYER_ID, enable3DEffects);
    setLayerVisibilitySafe('building-3d', enable3DEffects);

    // 2. Terrain DEM
    if (!enable3DEffects) {
      try {
        map.setTerrain(null);
      } catch {
        // Ignore if style is settling
      }
      return;
    }

    try {
      if (!map.getSource(TERRARIUM_SOURCE_ID)) {
        map.addSource(TERRARIUM_SOURCE_ID, {
          type: 'raster-dem',
          tiles: TERRARIUM_TILES,
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 15,
        });
      }
      map.setTerrain({ source: TERRARIUM_SOURCE_ID, exaggeration: 1.6 });
    } catch {
      // Safe fallback in offline/unsupported WebGL contexts
    }

    // 3. Directional 3D lighting & sky/fog atmosphere
    try {
      map.setLight({
        anchor: 'viewport',
        color: '#e2e8f0',
        intensity: 0.55,
        position: [1.3, 210, 35],
      });
    } catch {
      // Ignore if style doesn't support light
    }

    try {
      map.setSky(getSkyForBasemap(basemapMode));
    } catch {
      // Ignore if sky spec is unsupported
    }
  }

  function ensure3DEnhancementLayers(): void {
    if (offlineFallbackActive) return;

    const visibility: 'visible' | 'none' = is3D ? 'visible' : 'none';
    const beforeId = map.getLayer(RIBBON_GLOW_LAYER_ID) ? RIBBON_GLOW_LAYER_ID : undefined;

    // 1. Dedicated hillshade DEM source (separate from terrain source to avoid MapLibre artifacts)
    try {
      if (!map.getSource(TERRARIUM_HILLSHADE_SOURCE_ID)) {
        map.addSource(TERRARIUM_HILLSHADE_SOURCE_ID, {
          type: 'raster-dem',
          tiles: TERRARIUM_TILES,
          encoding: 'terrarium',
          tileSize: 256,
          maxzoom: 15,
        });
      }
      if (!map.getLayer(TERRARIUM_HILLSHADE_LAYER_ID)) {
        map.addLayer(
          {
            id: TERRARIUM_HILLSHADE_LAYER_ID,
            type: 'hillshade',
            source: TERRARIUM_HILLSHADE_SOURCE_ID,
            layout: { visibility },
            paint: {
              'hillshade-exaggeration': basemapMode === 'satellite' ? 0.45 : 0.65,
              'hillshade-shadow-color': '#020617',
              'hillshade-highlight-color': '#94a3b8',
              'hillshade-accent-color': '#0f172a',
            },
          },
          beforeId,
        );
      }
    } catch {
      // Safe fallback if hillshade fails
    }

    // 2. 3D Extruded Buildings (OpenFreeMap planet vector tiles) placed below the Telemetry Ribbon
    try {
      if (!map.getSource(BUILDINGS_SOURCE_ID)) {
        map.addSource(BUILDINGS_SOURCE_ID, {
          type: 'vector',
          url: OPENFREEMAP_PLANET_URL,
        });
      }
      if (!map.getLayer(BUILDINGS_LAYER_ID)) {
        // Hide Liberty's duplicate native 3D layer so our height-colored extrusion stays authoritative
        if (map.getLayer('building-3d')) {
          setLayerVisibilitySafe('building-3d', false);
        }
        map.addLayer(
          {
            id: BUILDINGS_LAYER_ID,
            type: 'fill-extrusion',
            source: BUILDINGS_SOURCE_ID,
            'source-layer': 'building',
            minzoom: 13.5,
            layout: { visibility },
            paint: getBuildingPaintForBasemap(basemapMode),
          },
          beforeId,
        );
      }
    } catch {
      // Safe fallback if OpenFreeMap vector source is unreachable
    }
  }

  function ensureTelemetryLayers(): void {
    // Install 3D hillshade & building layers first so telemetry sits cleanly on top
    ensure3DEnhancementLayers();

    if (!map.hasImage(VEHICLE_ARROW_IMAGE_ID)) {
      const img = createVehicleChevronImage();
      if (img) {
        map.addImage(VEHICLE_ARROW_IMAGE_ID, img, { pixelRatio: 2 });
      }
    }

    if (!map.getSource(RIBBON_SOURCE_ID)) {
      map.addSource(RIBBON_SOURCE_ID, {
        type: 'geojson',
        data: lastRibbonData ? lastRibbonData.ribbon : emptyLineCollection(),
      });
    }

    if (!map.getSource(TUNNEL_SOURCE_ID)) {
      map.addSource(TUNNEL_SOURCE_ID, {
        type: 'geojson',
        data: lastRibbonData ? lastRibbonData.tunnels : emptyLineCollection(),
      });
    }

    if (!map.getSource(VEHICLE_SOURCE_ID)) {
      map.addSource(VEHICLE_SOURCE_ID, {
        type: 'geojson',
        data: vehicleCollection,
      });
    }

    if (!map.getLayer(RIBBON_GLOW_LAYER_ID)) {
      map.addLayer({
        id: RIBBON_GLOW_LAYER_ID,
        type: 'line',
        source: RIBBON_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': 11,
          'line-opacity': 0.24,
          'line-blur': 4,
        },
      });
    }

    if (!map.getLayer(RIBBON_LAYER_ID)) {
      map.addLayer({
        id: RIBBON_LAYER_ID,
        type: 'line',
        source: RIBBON_SOURCE_ID,
        layout: { 'line-cap': 'round', 'line-join': 'round' },
        paint: {
          'line-color': ['get', 'color'],
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3.5, 16, 6.5],
          'line-opacity': 0.96,
        },
      });
    }

    if (!map.getLayer(TUNNEL_LAYER_ID)) {
      map.addLayer({
        id: TUNNEL_LAYER_ID,
        type: 'line',
        source: TUNNEL_SOURCE_ID,
        layout: { 'line-cap': 'butt', 'line-join': 'round' },
        paint: {
          'line-color': '#38bdf8',
          'line-width': ['interpolate', ['linear'], ['zoom'], 10, 3, 16, 5],
          'line-dasharray': [2, 2],
          'line-opacity': 0.92,
        },
      });
    }

    if (!map.getLayer(VEHICLE_HALO_LAYER_ID)) {
      map.addLayer({
        id: VEHICLE_HALO_LAYER_ID,
        type: 'circle',
        source: VEHICLE_SOURCE_ID,
        paint: {
          'circle-radius': 14,
          'circle-color': '#38bdf8',
          'circle-opacity': 0.24,
          'circle-stroke-width': 1.5,
          'circle-stroke-color': 'rgba(56, 189, 248, 0.55)',
        },
      });
    }

    if (!map.getLayer(VEHICLE_DOT_LAYER_ID)) {
      map.addLayer({
        id: VEHICLE_DOT_LAYER_ID,
        type: 'circle',
        source: VEHICLE_SOURCE_ID,
        paint: {
          'circle-radius': 5,
          'circle-color': '#f8fafc',
          'circle-stroke-width': 2,
          'circle-stroke-color': '#0284c7',
        },
      });
    }

    if (!map.getLayer(VEHICLE_ARROW_LAYER_ID) && map.hasImage(VEHICLE_ARROW_IMAGE_ID)) {
      map.addLayer({
        id: VEHICLE_ARROW_LAYER_ID,
        type: 'symbol',
        source: VEHICLE_SOURCE_ID,
        layout: {
          'icon-image': VEHICLE_ARROW_IMAGE_ID,
          'icon-size': 0.95,
          'icon-rotate': ['get', 'bearing'],
          'icon-rotation-alignment': 'map',
          'icon-allow-overlap': true,
          'icon-ignore-placement': true,
        },
      });
    }
  }

  map.on('style.load', () => {
    styleLoaded = true;
    clearWatchdog();
    ensureTelemetryLayers();
    apply3DEnvironment();
    setVehicleMarkerVisible(vehicleMarkerVisible);
    options.onStyleLoad?.(map);
    if (pendingFitOnStyleLoad && lastFitBounds) {
      pendingFitOnStyleLoad = false;
      fitToCurrentTrack();
    }
  });

  map.on('error', (event) => {
    console.error('[MapView]', event.error);
    if (!styleLoaded && !offlineFallbackActive) {
      const msg = event.error?.message ?? '';
      if (msg.includes('Failed to fetch') || msg.includes('NetworkError')) {
        triggerOfflineFallback();
      }
    }
  });

  function fitToCurrentTrack(): void {
    if (!lastFitBounds) return;
    // Switch to free camera so the next 60 FPS tick doesn't immediately override fitBounds
    cameraMode = 'free';
    const [sw, ne] = lastFitBounds;
    map.fitBounds(new maplibregl.LngLatBounds(sw, ne), {
      padding: { top: 88, bottom: 112, left: 356, right: 64 },
      pitch: is3D ? 65 : 0,
      duration: 750,
      maxZoom: 16.5,
    });
  }

  function renderTelemetryRibbon(
    soa: TelemetryTrackSoA,
    metricKey: RibbonMetric,
    fitToTrack: boolean = false,
  ): void {
    const built = buildTelemetryRibbonGeoJson(soa, metricKey);
    lastRibbonData = built;
    lastFitBounds = built.bounds;

    if (styleLoaded) {
      ensureTelemetryLayers();
      const ribbonSrc = map.getSource(RIBBON_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      const tunnelSrc = map.getSource(TUNNEL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      ribbonSrc?.setData(built.ribbon);
      tunnelSrc?.setData(built.tunnels);
      if (fitToTrack && built.bounds) {
        fitToCurrentTrack();
      }
    } else if (fitToTrack) {
      pendingFitOnStyleLoad = true;
    }
  }

  function updateVehiclePose(frame: SampleFrame): void {
    if (!isValidLatLon(frame.lat, frame.lon)) return;

    vehicleCoord[0] = frame.lon;
    vehicleCoord[1] = frame.lat;
    // ISO 8855 CCW from +East -> MapLibre clockwise bearing from +North
    const bearingDeg = (((90 - frame.yaw * RAD_TO_DEG) % 360) + 360) % 360;
    vehicleFeature.properties.bearing = bearingDeg;
    vehicleFeature.properties.speedKmh = frame.speedMs * 3.6;

    if (!hasVehiclePose) {
      vehicleCollection.features = [vehicleFeature];
      hasVehiclePose = true;
    }

    if (styleLoaded) {
      const src = map.getSource(VEHICLE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      src?.setData(vehicleCollection);
    }

    if (!externalCameraControl) {
      if (cameraMode === 'chase') {
        map.jumpTo({
          center: vehicleCoord,
          bearing: bearingDeg,
          pitch: is3D ? 65 : 0,
        });
      } else if (cameraMode === 'topdown') {
        map.jumpTo({
          center: vehicleCoord,
          bearing: 0,
          pitch: 0,
        });
      }
    }
  }

  function setVehicleMarkerVisible(nextVisible: boolean): void {
    vehicleMarkerVisible = nextVisible;
    if (!styleLoaded) return;
    setLayerVisibilitySafe(VEHICLE_HALO_LAYER_ID, nextVisible);
    setLayerVisibilitySafe(VEHICLE_DOT_LAYER_ID, nextVisible);
    setLayerVisibilitySafe(VEHICLE_ARROW_LAYER_ID, nextVisible);
  }

  function clearTrack(): void {
    lastRibbonData = null;
    lastFitBounds = null;
    hasVehiclePose = false;
    vehicleCollection.features = [];
    if (styleLoaded) {
      const ribbonSrc = map.getSource(RIBBON_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      const tunnelSrc = map.getSource(TUNNEL_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      const vehicleSrc = map.getSource(VEHICLE_SOURCE_ID) as maplibregl.GeoJSONSource | undefined;
      ribbonSrc?.setData(emptyLineCollection());
      tunnelSrc?.setData(emptyLineCollection());
      vehicleSrc?.setData(vehicleCollection);
    }
  }

  function set3DMode(enabled: boolean): void {
    is3D = enabled;
    apply3DEnvironment();

    if (!enabled) {
      map.easeTo({
        pitch: 0,
        bearing: 0,
        duration: 550,
      });
      return;
    }

    // Ensure 3D buildings become immediately visible when switching into 3D
    const targetZoom = Math.max(map.getZoom(), MIN_3D_ZOOM);
    map.easeTo({
      pitch: 65,
      zoom: targetZoom,
      duration: 650,
    });
  }

  function setBasemap(mode: BasemapMode): void {
    if (mode === basemapMode && !offlineFallbackActive) return;
    basemapMode = mode;
    offlineFallbackActive = false;
    options.onOfflineFallback?.(false);
    styleLoaded = false;
    armWatchdog();
    map.setStyle(getStyleForBasemap(mode));
  }

  function setCameraMode(mode: CameraMode): void {
    cameraMode = mode;
    if (mode === 'topdown') {
      map.easeTo({ pitch: 0, bearing: 0, duration: 350 });
    } else if (mode === 'chase' && hasVehiclePose) {
      map.easeTo({
        center: vehicleCoord,
        bearing: vehicleFeature.properties.bearing,
        pitch: is3D ? 65 : 0,
        duration: 350,
      });
    }
  }

  function dispose(): void {
    clearWatchdog();
    map.remove();
  }

  return {
    getMap: () => map,
    renderTelemetryRibbon,
    updateVehiclePose,
    setVehicleMarkerVisible,
    clearTrack,
    set3DMode,
    setBasemap,
    getBasemap: () => basemapMode,
    setCameraMode,
    fitToCurrentTrack,
    dispose,
  };
}
