/**
 * Camada 3D Three.js integrada no MapLibre GL v4/v5/v6 (`CustomLayerInterface`).
 * - Usa `render(gl, options)` com `options.defaultProjectionData.mainMatrix` e
 *   `MercatorCoordinate.fromLngLat([lon, lat], elevation)`.
 * - Guarda obrigatória contra `null`/`NaN` em `map.queryTerrainElevation()` via `resolveTerrainElevation`.
 * - Modos de câmara: `chase` (bearing suavizado + pitch 62°), `topdown` (pitch 0°, norte-cima ou heading-cima)
 *   e `free` (alterna automaticamente ao arrastar o mapa com o rato durante Chase).
 *
 * Testes:
 *   npx vitest run test/ui/vehicleRig.test.ts
 */
import * as maplibregl from 'maplibre-gl';
import * as THREE from 'three';
import type { SampleFrame } from '../core/interpolator.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';
import type { CameraMode } from '../state/appStore.ts';
import {
  createProceduralVehicleRig,
  type VehicleRig,
  type VehicleRigUpdateOptions,
} from './vehicleRig.ts';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const WGS84_A = 6378137.0;
const CHASE_PITCH_DEG = 62;
const CHASE_BEARING_ALPHA = 0.18;
const MAX_TERRAIN_SLOPE_RAD = 0.45;
const GROUND_CLEARANCE_M = 0.03;

export interface WheelTerrainElevations {
  fl: number;
  fr: number;
  rl: number;
  rr: number;
}

export interface TerrainPlanePose {
  elevation: number;
  terrainPitchRad: number;
  terrainRollRad: number;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/**
 * Pure interaction guard: releases `'chase'` only when a MapLibre movement event
 * comes from real user input (`originalEvent` present), ignoring programmatic `jumpTo`/`easeTo`.
 */
export function shouldReleaseChaseOnInteraction(
  cameraMode: CameraMode,
  event?: { originalEvent?: unknown },
): boolean {
  return cameraMode === 'chase' && Boolean(event?.originalEvent);
}

/**
 * Computes ISO 8855 terrain slope (`terrainPitchRad`, `terrainRollRad`) and safe base Z
 * elevation across all 4 tire contact patches so neither side sinks into sloped DEM tiles.
 */
export function computeTerrainPlanePose(
  centerElev: number,
  wheelElevs: WheelTerrainElevations | null,
  specs: Pick<ResolvedVehicleSpecs, 'wheelbaseL' | 'trackF' | 'trackR' | 'frontWeightRatio'>,
): TerrainPlanePose {
  const safeCenter = Number.isFinite(centerElev) ? centerElev : 0;
  if (
    !wheelElevs ||
    !Number.isFinite(wheelElevs.fl) ||
    !Number.isFinite(wheelElevs.fr) ||
    !Number.isFinite(wheelElevs.rl) ||
    !Number.isFinite(wheelElevs.rr)
  ) {
    return {
      elevation: safeCenter + GROUND_CLEARANCE_M,
      terrainPitchRad: 0,
      terrainRollRad: 0,
    };
  }

  const L = Math.max(1.5, specs.wheelbaseL || 2.65);
  const tf = Math.max(1.0, specs.trackF || 1.55);
  const tr = Math.max(1.0, specs.trackR || 1.55);
  const lr = L * specs.frontWeightRatio;
  const lf = L - lr;
  const avgTrack = 0.5 * (tf + tr);

  const zFront = 0.5 * (wheelElevs.fl + wheelElevs.fr);
  const zRear = 0.5 * (wheelElevs.rl + wheelElevs.rr);
  const zLeft = 0.5 * (wheelElevs.fl + wheelElevs.rl);
  const zRight = 0.5 * (wheelElevs.fr + wheelElevs.rr);

  // ISO 8855: +pitch (+Y) = nose down => uphill (zFront > zRear) is negative pitch
  const terrainPitchRad = clamp(
    -Math.atan2(zFront - zRear, L),
    -MAX_TERRAIN_SLOPE_RAD,
    MAX_TERRAIN_SLOPE_RAD,
  );
  // ISO 8855: +roll (+X) = right side down / left side up => zLeft > zRight is positive roll
  const terrainRollRad = clamp(
    Math.atan2(zLeft - zRight, avgTrack),
    -MAX_TERRAIN_SLOPE_RAD,
    MAX_TERRAIN_SLOPE_RAD,
  );

  // Rotate (wx, wy, 0) by Ry(pitch) * Rx(roll) => zOffset = -wx * sinP + wy * sinR * cosP
  const sinP = Math.sin(terrainPitchRad);
  const cosP = Math.cos(terrainPitchRad);
  const sinR = Math.sin(terrainRollRad);

  const reqFL = wheelElevs.fl - (-lf * sinP + tf * 0.5 * sinR * cosP);
  const reqFR = wheelElevs.fr - (-lf * sinP - tf * 0.5 * sinR * cosP);
  const reqRL = wheelElevs.rl - (lr * sinP + tr * 0.5 * sinR * cosP);
  const reqRR = wheelElevs.rr - (lr * sinP - tr * 0.5 * sinR * cosP);

  return {
    elevation: Math.max(safeCenter, reqFL, reqFR, reqRL, reqRR) + GROUND_CLEARANCE_M,
    terrainPitchRad,
    terrainRollRad,
  };
}

/**
 * Safe DEM elevation guard: returns `queried` when finite, otherwise falls back
 * to `lastValid` (if finite) or `0`, guaranteeing zero `NaN` propagation while
 * terrain tiles load or in offline mode.
 */
export function resolveTerrainElevation(
  queried: number | null | undefined,
  lastValid: number = 0,
): number {
  if (typeof queried === 'number' && Number.isFinite(queried)) {
    return queried;
  }
  return Number.isFinite(lastValid) ? lastValid : 0;
}

function smoothBearingDeg(currentDeg: number, targetDeg: number, alpha: number): number {
  const delta = (((targetDeg - currentDeg + 540) % 360) - 180);
  return (((currentDeg + delta * alpha) % 360) + 360) % 360;
}

export interface ThreeVehicleLayerOptions {
  id?: string;
  initialSpecs: ResolvedVehicleSpecs;
  rigFactory?: (specs: ResolvedVehicleSpecs) => VehicleRig;
  initialCameraMode?: CameraMode;
  topDownHeadingUp?: boolean;
  onCameraModeChange?: (mode: CameraMode) => void;
}

export interface ThreeVehicleLayerController {
  readonly layer: maplibregl.CustomLayerInterface;
  updateFrame(
    frame: SampleFrame,
    specs: ResolvedVehicleSpecs,
    opts?: VehicleRigUpdateOptions,
  ): void;
  setSpecs(specs: ResolvedVehicleSpecs): void;
  setCameraMode(mode: CameraMode, topDownHeadingUp?: boolean): void;
  getCameraMode(): CameraMode;
  setVisible(visible: boolean): void;
  getLastElevation(): number;
  dispose(): void;
}

/**
 * Creates a MapLibre `CustomLayerInterface` rendering a `VehicleRig` in Three.js
 * directly anchored to the terrain DEM elevation with smooth Chase/Top-Down/Free cameras.
 */
export function createThreeVehicleLayer(
  options: ThreeVehicleLayerOptions,
): ThreeVehicleLayerController {
  const layerId = options.id ?? 'three-vehicle-layer';
  const rigFactory = options.rigFactory ?? createProceduralVehicleRig;

  let mapRef: maplibregl.Map | null = null;
  let renderer: THREE.WebGLRenderer | null = null;
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();

  // Motorsport lighting rig (+Z up in ISO 8855)
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
  const hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x1e293b, 0.7);
  hemiLight.position.set(0, 0, 1);
  const dirLight = new THREE.DirectionalLight(0xffffff, 1.15);
  dirLight.position.set(18, -14, 30);
  scene.add(ambientLight, hemiLight, dirLight);

  let currentSpecs = options.initialSpecs;
  let rig: VehicleRig = rigFactory(currentSpecs);
  scene.add(rig.getObject3D());

  let visible = false;
  let hasPose = false;
  let lon = 0;
  let lat = 0;
  let yawRad = 0;
  let lastValidElevation = 0;

  let cameraMode: CameraMode = options.initialCameraMode ?? 'chase';
  let topDownHeadingUp = options.topDownHeadingUp ?? false;
  let smoothedBearingDeg: number | null = null;

  // Pre-allocated matrices to avoid GC churn inside 60 FPS render()
  const mvpMatrix = new THREE.Matrix4();
  const modelMatrix = new THREE.Matrix4();
  const translationMatrix = new THREE.Matrix4();
  const scaleMatrix = new THREE.Matrix4();
  const rotationZMatrix = new THREE.Matrix4();
  const rotationYMatrix = new THREE.Matrix4();
  const rotationXMatrix = new THREE.Matrix4();

  const onUserMapInteraction = (event?: { originalEvent?: unknown }) => {
    if (!shouldReleaseChaseOnInteraction(cameraMode, event)) return;
    cameraMode = 'free';
    options.onCameraModeChange?.('free');
  };

  const layer: maplibregl.CustomLayerInterface = {
    id: layerId,
    type: 'custom',
    renderingMode: '3d',

    onAdd(map: maplibregl.Map, gl: WebGLRenderingContext | WebGL2RenderingContext) {
      mapRef = map;
      renderer = new THREE.WebGLRenderer({
        canvas: map.getCanvas(),
        context: gl,
        antialias: true,
      });
      renderer.autoClear = false;

      map.on('dragstart', onUserMapInteraction);
      map.on('rotatestart', onUserMapInteraction);
    },

    render(_gl: WebGLRenderingContext | WebGL2RenderingContext, renderOptions: maplibregl.CustomRenderMethodInput) {
      if (!renderer || !mapRef || !visible || !hasPose) return;

      const hasTerrain =
        typeof mapRef.getTerrain === 'function' ? Boolean(mapRef.getTerrain()) : true;

      let elevation = 0;
      let terrainPitchRad = 0;
      let terrainRollRad = 0;

      if (hasTerrain) {
        let queriedCenter: number | null | undefined;
        try {
          queriedCenter = mapRef.queryTerrainElevation([lon, lat]);
        } catch {
          queriedCenter = null;
        }

        const centerElev = resolveTerrainElevation(queriedCenter, lastValidElevation);
        lastValidElevation = centerElev;

        let wheelElevs: WheelTerrainElevations | null = null;
        if (typeof queriedCenter === 'number' && Number.isFinite(queriedCenter)) {
          const L = Math.max(1.5, currentSpecs.wheelbaseL || 2.65);
          const tf = Math.max(1.0, currentSpecs.trackF || 1.55);
          const tr = Math.max(1.0, currentSpecs.trackR || 1.55);
          const lr = L * currentSpecs.frontWeightRatio;
          const lf = L - lr;
          const cosYaw = Math.cos(yawRad);
          const sinYaw = Math.sin(yawRad);
          const metersPerDegLat = WGS84_A * DEG_TO_RAD;
          const metersPerDegLon = metersPerDegLat * Math.max(0.05, Math.cos(lat * DEG_TO_RAD));

          const queryWheel = (dx: number, dy: number): number | null => {
            const eastM = dx * cosYaw - dy * sinYaw;
            const northM = dx * sinYaw + dy * cosYaw;
            const wLon = lon + eastM / metersPerDegLon;
            const wLat = lat + northM / metersPerDegLat;
            const q = mapRef?.queryTerrainElevation([wLon, wLat]);
            return typeof q === 'number' && Number.isFinite(q) ? q : null;
          };

          try {
            const fl = queryWheel(lf, tf * 0.5);
            const fr = queryWheel(lf, -tf * 0.5);
            const rl = queryWheel(-lr, tr * 0.5);
            const rr = queryWheel(-lr, -tr * 0.5);
            if (fl !== null && fr !== null && rl !== null && rr !== null) {
              wheelElevs = { fl, fr, rl, rr };
            }
          } catch {
            wheelElevs = null;
          }
        }

        const terrainPose = computeTerrainPlanePose(centerElev, wheelElevs, currentSpecs);
        elevation = terrainPose.elevation;
        terrainPitchRad = terrainPose.terrainPitchRad;
        terrainRollRad = terrainPose.terrainRollRad;
      }

      const mercator = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], elevation);
      const scale = mercator.meterInMercatorCoordinateUnits();

      // Map ISO 8855 (+X East at yaw=0, +Y North, +Z Up) into MapLibre Mercator (+X East, +Y South, +Z Up)
      translationMatrix.makeTranslation(mercator.x, mercator.y, mercator.z ?? 0);
      scaleMatrix.makeScale(scale, -scale, scale);
      rotationZMatrix.makeRotationZ(yawRad);
      rotationYMatrix.makeRotationY(terrainPitchRad);
      rotationXMatrix.makeRotationX(terrainRollRad);

      modelMatrix
        .copy(translationMatrix)
        .multiply(scaleMatrix)
        .multiply(rotationZMatrix)
        .multiply(rotationYMatrix)
        .multiply(rotationXMatrix);

      mvpMatrix
        .fromArray(renderOptions.defaultProjectionData.mainMatrix)
        .multiply(modelMatrix);

      camera.projectionMatrix.copy(mvpMatrix);

      renderer.resetState();
      renderer.render(scene, camera);
    },

    onRemove(map: maplibregl.Map) {
      map.off('dragstart', onUserMapInteraction);
      map.off('rotatestart', onUserMapInteraction);
      renderer?.dispose();
      renderer = null;
      mapRef = null;
    },
  };

  function updateFrame(
    frame: SampleFrame,
    specs: ResolvedVehicleSpecs,
    opts?: VehicleRigUpdateOptions,
  ): void {
    if (!Number.isFinite(frame.lat) || !Number.isFinite(frame.lon)) return;
    if (Math.abs(frame.lat) < 1e-5 && Math.abs(frame.lon) < 1e-5) return;

    lon = frame.lon;
    lat = frame.lat;
    yawRad = frame.yaw;
    hasPose = true;
    visible = true;

    rig.updatePose(frame, specs, opts);

    if (mapRef) {
      const targetBearing = (((90 - frame.yaw * RAD_TO_DEG) % 360) + 360) % 360;

      if (cameraMode === 'chase') {
        smoothedBearingDeg =
          smoothedBearingDeg === null
            ? targetBearing
            : smoothBearingDeg(smoothedBearingDeg, targetBearing, CHASE_BEARING_ALPHA);

        mapRef.jumpTo({
          center: [lon, lat],
          bearing: smoothedBearingDeg,
          pitch: CHASE_PITCH_DEG,
        });
      } else if (cameraMode === 'topdown') {
        mapRef.jumpTo({
          center: [lon, lat],
          bearing: topDownHeadingUp ? targetBearing : 0,
          pitch: 0,
        });
      }

      mapRef.triggerRepaint();
    }
  }

  function setSpecs(specs: ResolvedVehicleSpecs): void {
    currentSpecs = specs;
    scene.remove(rig.getObject3D());
    rig.dispose();
    rig = rigFactory(currentSpecs);
    scene.add(rig.getObject3D());
    mapRef?.triggerRepaint();
  }

  function setCameraMode(mode: CameraMode, nextTopDownHeadingUp?: boolean): void {
    cameraMode = mode;
    if (nextTopDownHeadingUp !== undefined) {
      topDownHeadingUp = nextTopDownHeadingUp;
    }

    if (!mapRef) return;
    if (mode === 'topdown') {
      const targetBearing = (((90 - yawRad * RAD_TO_DEG) % 360) + 360) % 360;
      mapRef.easeTo({
        pitch: 0,
        bearing: topDownHeadingUp ? targetBearing : 0,
        duration: 350,
      });
    } else if (mode === 'chase' && hasPose) {
      const targetBearing = (((90 - yawRad * RAD_TO_DEG) % 360) + 360) % 360;
      smoothedBearingDeg = targetBearing;
      mapRef.easeTo({
        center: [lon, lat],
        bearing: targetBearing,
        pitch: CHASE_PITCH_DEG,
        duration: 350,
      });
    }
  }

  function setVisible(nextVisible: boolean): void {
    visible = nextVisible;
    mapRef?.triggerRepaint();
  }

  function dispose(): void {
    if (mapRef) {
      mapRef.off('dragstart', onUserMapInteraction);
      mapRef.off('rotatestart', onUserMapInteraction);
      if (mapRef.getLayer(layerId)) {
        mapRef.removeLayer(layerId);
      }
    }
    scene.remove(rig.getObject3D());
    rig.dispose();
    renderer?.dispose();
    renderer = null;
    mapRef = null;
  }

  return {
    layer,
    updateFrame,
    setSpecs,
    setCameraMode,
    getCameraMode: () => cameraMode,
    setVisible,
    getLastElevation: () => lastValidElevation,
    dispose,
  };
}
