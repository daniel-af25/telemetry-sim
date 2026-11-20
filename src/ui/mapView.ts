/**
 * Componente de mapa MapLibre GL 2D/3D com terreno DEM gratuito (AWS Terrarium),
 * fallback resiliente offline, Telemetry Ribbon quantizado (`RdYlGn_r`), camada
 * tracejada para túneis (`IS_TUNNEL_DR`) e marcador animado do veículo a 60 FPS.
 *
 * Testes:
 *   npx vitest run test/ui/mapView.test.ts
 */
import * as maplibregl from 'maplibre-gl';
import 'maplibre-gl/dist/maplibre-gl.css';
import type { Feature, FeatureCollection, LineString, Point } from 'geojson';
import type { SampleFrame } from '../core/interpolator.ts';
import { TRACK_FLAG, type TelemetryTrackSoA } from '../core/soa.ts';
import type { CameraMode, RibbonMetric } from '../state/appStore.ts';

const GRAVITY_MS2 = 9.80665;
const RAD_TO_DEG = 180 / Math.PI;

const DEFAULT_CENTER: [number, number] = [-8.611, 41.1579]; // Porto, Portugal
const DEFAULT_ZOOM = 12;

const EXTERNAL_STYLES = [
  'https://tiles.openfreemap.org/styles/fiord',
  'https://tiles.openfreemap.org/styles/liberty',
] as const;

const TERRARIUM_SOURCE_ID = 'terrarium-dem';
const TERRARIUM_TILES = [
  'https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png',
];

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

const STYLE_LOAD_TIMEOUT_MS = 4500;
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
  return Math.min(RDYLGN_R_PALETTE.length - 1, Math.floor(norm * (RDYLGN_R_PALETTE.length - 1) + 1e-9));
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
  clearTrack(): void;
  set3DMode(enabled: boolean): void;
  setCameraMode(mode: CameraMode): void;
  fitToCurrentTrack(): void;
  dispose(): void;
}

/**
 * Instantiates and manages the MapLibre GL 2D/3D map, AWS Terrarium DEM terrain,
 * resilient offline dark fallback, Telemetry Ribbon, tunnel layer, and 60 FPS vehicle pose.
 */
export function createMapView(
  container: HTMLElement,
  options: MapViewOptions = {},
): MapViewController {
  let is3D = options.initial3D ?? true;
  let cameraMode: CameraMode = 'chase';
  let offlineFallbackActive =
    typeof navigator !== 'undefined' && navigator.onLine === false;
  let styleIndex = 0;
  let styleLoaded = false;
  let styleWatchdog: ReturnType<typeof setTimeout> | null = null;
  let lastRibbonData: TelemetryRibbonGeoJson | null = null;
  let lastFitBounds: [[number, number], [number, number]] | null = null;
  let hasVehiclePose = false;

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
    : EXTERNAL_STYLES[0];

  const map = new maplibregl.Map({
    container,
    style: initialStyle,
    center: DEFAULT_CENTER,
    zoom: DEFAULT_ZOOM,
    pitch: is3D ? 60 : 0,
    bearing: 0,
    maxPitch: 85,
    attributionControl: { compact: true },
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

  function triggerStyleFallback(): void {
    clearWatchdog();
    if (offlineFallbackActive) return;

    if (styleIndex + 1 < EXTERNAL_STYLES.length) {
      styleIndex += 1;
      const nextUrl = EXTERNAL_STYLES[styleIndex];
      if (nextUrl) {
        armWatchdog();
        map.setStyle(nextUrl);
        return;
      }
    }

    offlineFallbackActive = true;
    options.onOfflineFallback?.(true);
    map.setStyle(OFFLINE_DARK_STYLE);
  }

  function armWatchdog(): void {
    clearWatchdog();
    if (offlineFallbackActive) return;
    styleWatchdog = setTimeout(() => {
      if (!styleLoaded) {
        triggerStyleFallback();
      }
    }, STYLE_LOAD_TIMEOUT_MS);
  }

  armWatchdog();

  if (offlineFallbackActive) {
    options.onOfflineFallback?.(true);
  }

  function applyTerrain(): void {
    if (!styleLoaded) return;
    if (!is3D || offlineFallbackActive) {
      try {
        map.setTerrain(null);
      } catch {
        // Ignore if style is still settling
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
      map.setTerrain({ source: TERRARIUM_SOURCE_ID, exaggeration: 1.2 });
    } catch {
      // Safe fallback in offline/unsupported WebGL contexts
    }
  }

  function ensureTelemetryLayers(): void {
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
          'line-opacity': 0.22,
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
          'circle-opacity': 0.22,
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
    applyTerrain();
  });

  map.on('error', (event) => {
    // Only fall back to offline dark style if base style failed before loading
    if (!styleLoaded && !offlineFallbackActive) {
      const msg = event.error?.message ?? '';
      if (
        msg.includes('Failed to fetch') ||
        msg.includes('NetworkError') ||
        msg.includes('404') ||
        msg.includes('style') ||
        !map.isStyleLoaded()
      ) {
        triggerStyleFallback();
      }
    }
  });

  function fitToCurrentTrack(): void {
    if (!lastFitBounds) return;
    const [sw, ne] = lastFitBounds;
    map.fitBounds(
      new maplibregl.LngLatBounds(sw, ne),
      {
        padding: { top: 88, bottom: 112, left: 356, right: 64 },
        pitch: is3D ? 60 : 0,
        duration: 750,
        maxZoom: 16.5,
      },
    );
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
    }

    if (fitToTrack && built.bounds) {
      fitToCurrentTrack();
    }
  }

  function updateVehiclePose(frame: SampleFrame): void {
    if (!isValidLatLon(frame.lat, frame.lon)) return;

    vehicleCoord[0] = frame.lon;
    vehicleCoord[1] = frame.lat;
    // ISO 8855 CCW from +East -> MapLibre clockwise bearing from +North
    const bearingDeg = ((90 - frame.yaw * RAD_TO_DEG) % 360 + 360) % 360;
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

    if (cameraMode === 'chase') {
      map.jumpTo({
        center: vehicleCoord,
        bearing: bearingDeg,
        pitch: is3D ? 60 : 0,
      });
    } else if (cameraMode === 'topdown') {
      map.jumpTo({
        center: vehicleCoord,
        bearing: 0,
        pitch: 0,
      });
    }
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
    applyTerrain();
    map.easeTo({
      pitch: enabled ? 60 : 0,
      duration: 450,
    });
  }

  function setCameraMode(mode: CameraMode): void {
    cameraMode = mode;
    if (mode === 'topdown') {
      map.easeTo({ pitch: 0, bearing: 0, duration: 350 });
    } else if (mode === 'chase' && hasVehiclePose) {
      map.easeTo({
        center: vehicleCoord,
        bearing: vehicleFeature.properties.bearing,
        pitch: is3D ? 60 : 0,
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
    clearTrack,
    set3DMode,
    setCameraMode,
    fitToCurrentTrack,
    dispose,
  };
}
