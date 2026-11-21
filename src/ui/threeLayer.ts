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
const CHASE_PITCH_DEG = 62;
const CHASE_BEARING_ALPHA = 0.18;

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

  // Motorsport lighting rig
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.75);
  const hemiLight = new THREE.HemisphereLight(0xe0f2fe, 0x1e293b, 0.7);
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

  const onUserMapInteraction = () => {
    if (cameraMode === 'chase') {
      cameraMode = 'free';
      options.onCameraModeChange?.('free');
    }
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

      let queriedElevation: number | null | undefined;
      try {
        queriedElevation = mapRef.queryTerrainElevation([lon, lat]);
      } catch {
        queriedElevation = null;
      }

      const elevation = resolveTerrainElevation(queriedElevation, lastValidElevation);
      lastValidElevation = elevation;

      const mercator = maplibregl.MercatorCoordinate.fromLngLat([lon, lat], elevation);
      const scale = mercator.meterInMercatorCoordinateUnits();

      // Map ISO 8855 (+X East at yaw=0, +Y North, +Z Up) into MapLibre Mercator (+X East, +Y South, +Z Up)
      translationMatrix.makeTranslation(mercator.x, mercator.y, mercator.z ?? 0);
      scaleMatrix.makeScale(scale, -scale, scale);
      rotationZMatrix.makeRotationZ(yawRad);

      modelMatrix
        .copy(translationMatrix)
        .multiply(scaleMatrix)
        .multiply(rotationZMatrix);

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
