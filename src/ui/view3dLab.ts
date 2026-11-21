/**
 * Lab 3D Isométrico / Perspetiva ao Vivo (`src/ui/view3dLab.ts` — Three.js 60 FPS).
 * Réplica interativa em Dark Motorsport de `tools/view3d.py` do `rallysim-master`:
 * - Lazy-init de `THREE.WebGLRenderer` (só cria contexto WebGL quando exibido).
 * - Referencial nativo ISO 8855 (`camera.up.set(0, 0, 1)`), carro na origem local `(0, 0, z)`
 *   para eliminar jitter Float32, grelha móvel de `2 m` e rasto de `4.0 s` pré-alocado.
 * - Câmara dual (`OrthographicCamera` isométrica verdadeira 35.264° / -45° por omissão,
 *   alternável para `PerspectiveCamera` 22° / -60° via botão ou tecla `P`), `Chase` (`C`),
 *   órbita com arrasto de rato e zoom com roda.
 * - Geometria 100% pré-alocada atualizada in-place (zero alocações no loop 60 FPS):
 *   chassis translúcido (`Rz·Ry·Rx`), 4 molas `coolwarm`, 4 rodas com aro `RdYlGn_r` e
 *   raio rotativo `π/2 - spin`, discos de aderência, setas `Fz` azuis outboard, forças
 *   de pneu brancas, velocidade verde, resultante laranja e arco roxo de `yaw_moment`.
 * - Painel HUD lateral fiel a `write_hud` + `input_bars.py` (100% sanitizado via `textContent`).
 */
import * as THREE from 'three';
import type { SampleFrame } from '../core/interpolator.ts';
import { TRACK_FLAG, type TelemetryTrackSoA } from '../core/soa.ts';
import type { KammLimits } from '../core/types.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';
import {
  BODY_TOP_M,
  BODY_WIDTH_MARGIN_M,
  computeLabFrameDynamics,
  coolwarmColorHex,
  findTrackIndexAtOrBefore,
  gripColorHex,
  ISO_AZIM_RAD,
  ISO_ELEV_RAD,
  LAB_WHEEL_IDS,
  LOAD_OFFSET_M,
  OVERHANG_M,
  STRUT_LENGTH_M,
  TRAIL_3D_SEC,
  VELOCITY_TIME_S,
  YAW_ARC_MAX_SWEEP_RAD,
  YAW_ARC_RADIUS_M,
  type LabRunScales,
  type LabWheelId,
} from './labTelemetryMath.ts';

const RAD_TO_DEG = 180 / Math.PI;
const DEG_TO_RAD = Math.PI / 180;
const PERSP_DEFAULT_ELEV_RAD = 22 * DEG_TO_RAD;
const PERSP_DEFAULT_AZIM_RAD = -60 * DEG_TO_RAD;
const MAX_TRAIL_VERTICES = 1024;
const YAW_ARC_SAMPLES = 40;
const GRID_HALF_M = 12;
const GRID_STEP_M = 2;

export interface View3dLabSessionData {
  sessionLabel: string;
  vehicleSpecs: ResolvedVehicleSpecs;
  kammLimits: KammLimits;
  track: TelemetryTrackSoA;
  scales: LabRunScales;
}

export interface View3dLabOptions {
  container: HTMLElement;
  initialExaggerate?: number;
  onCameraStateChange?: () => void;
}

export interface View3dLabController {
  readonly element: HTMLElement;
  setSessionData(data: View3dLabSessionData): void;
  setExaggerate(exaggerate: number): void;
  getExaggerate(): number;
  setIsometric(isometric: boolean): void;
  isIsometric(): boolean;
  setChase(chase: boolean): void;
  isChase(): boolean;
  resetCamera(): void;
  updateFrame(tSec: number, frame: SampleFrame | null, dtSec: number): void;
  resize(): void;
  dispose(): void;
}

interface Arrow3D {
  group: THREE.Group;
  shaft: THREE.Mesh;
  cone: THREE.Mesh;
  mat: THREE.MeshBasicMaterial;
  coneLen: number;
}

interface Wheel3DNodes {
  strut: THREE.Mesh;
  strutMat: THREE.MeshBasicMaterial;
  wheelGroup: THREE.Group;
  ringMesh: THREE.Mesh;
  ringMat: THREE.MeshBasicMaterial;
  spokeLine: THREE.Line;
  discMesh: THREE.Mesh;
  discMat: THREE.MeshBasicMaterial;
  discBorder: THREE.LineLoop;
  fzArrow: Arrow3D;
  forceArrow: Arrow3D;
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

function createArrow3D(
  colorHex: number,
  shaftRadius: number,
  coneRadius: number,
  coneLen: number,
  renderOrder: number,
): Arrow3D {
  const group = new THREE.Group();
  group.visible = false;

  const mat = new THREE.MeshBasicMaterial({
    color: colorHex,
    depthTest: false,
    transparent: true,
    opacity: 0.95,
  });

  // Base arrow aligned along +Z from z = 0 to z = 1
  const shaftGeo = new THREE.CylinderGeometry(shaftRadius, shaftRadius, 1, 10);
  shaftGeo.rotateX(Math.PI / 2);
  shaftGeo.translate(0, 0, 0.5);
  const shaft = new THREE.Mesh(shaftGeo, mat);
  shaft.renderOrder = renderOrder;

  const coneGeo = new THREE.ConeGeometry(coneRadius, coneLen, 12);
  coneGeo.rotateX(Math.PI / 2);
  const cone = new THREE.Mesh(coneGeo, mat);
  cone.renderOrder = renderOrder;

  group.add(shaft, cone);
  return { group, shaft, cone, mat, coneLen };
}

const UP_Z = new THREE.Vector3(0, 0, 1);
const TEMP_DIR = new THREE.Vector3();
const TEMP_QUAT = new THREE.Quaternion();
const TEMP_LOCAL = new THREE.Vector3();
const TEMP_TOP = new THREE.Vector3();
const TEMP_HUB = new THREE.Vector3();
const TEMP_MID = new THREE.Vector3();

function setArrowVector(
  arrow: Arrow3D,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
): void {
  const len = Math.hypot(dx, dy, dz);
  if (!Number.isFinite(len) || len < 0.015) {
    arrow.group.visible = false;
    return;
  }

  arrow.group.visible = true;
  arrow.group.position.set(ox, oy, oz);
  TEMP_DIR.set(dx / len, dy / len, dz / len);
  TEMP_QUAT.setFromUnitVectors(UP_Z, TEMP_DIR);
  arrow.group.quaternion.copy(TEMP_QUAT);

  const head = Math.min(arrow.coneLen, len * 0.42);
  const shaftLen = Math.max(0.005, len - head * 0.7);
  arrow.shaft.scale.set(1, 1, shaftLen);
  arrow.cone.scale.set(1, 1, head / arrow.coneLen);
  arrow.cone.position.set(0, 0, shaftLen + head * 0.35);
}

function buildGroundGrid(): THREE.LineSegments {
  const positions: number[] = [];
  for (let g = -GRID_HALF_M; g <= GRID_HALF_M; g += GRID_STEP_M) {
    positions.push(g, -GRID_HALF_M, 0, g, GRID_HALF_M, 0);
    positions.push(-GRID_HALF_M, g, 0, GRID_HALF_M, g, 0);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  const mat = new THREE.LineBasicMaterial({
    color: 0x334155,
    transparent: true,
    opacity: 0.55,
  });
  return new THREE.LineSegments(geo, mat);
}

function buildWheelRingGeometry(radius: number): THREE.BufferGeometry {
  // Torus/Tube ring lying in the XZ plane (+X fwd, +Z up) so yaw rotates cleanly around +Z
  const pts: number[] = [];
  const segs = 36;
  for (let i = 0; i <= segs; i++) {
    const a = (i / segs) * Math.PI * 2;
    pts.push(Math.cos(a) * radius, 0, Math.sin(a) * radius);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
  return geo;
}

/**
 * Creates the live 60 FPS 3D Isometric / Perspective Lab (`view3d.py` Three.js replica).
 */
export function createView3dLab(options: View3dLabOptions): View3dLabController {
  let session: View3dLabSessionData | null = null;
  let exaggerate = options.initialExaggerate ?? 4.0;
  let isometric = true;
  let chase = false;
  let elevRad = ISO_ELEV_RAD;
  let azimRad = ISO_AZIM_RAD;
  let zoomScale = 1.0;

  let lastTimeSec = 0;
  let lastFrame: SampleFrame | null = null;
  let wheelSpinRad = 0;
  let cachedStageW = 0;
  let cachedStageH = 0;
  let cachedDpr = 0;
  let cachedZoom = 0;

  // Lazy-initialized Three.js objects
  let renderer: THREE.WebGLRenderer | null = null;
  let scene: THREE.Scene | null = null;
  let orthoCam: THREE.OrthographicCamera | null = null;
  let perspCam: THREE.PerspectiveCamera | null = null;
  let groundGrid: THREE.LineSegments | null = null;
  let trailLine: THREE.Line | null = null;
  let trailPositions: Float32Array | null = null;
  let chassisGroup: THREE.Group | null = null;
  let cgDot: THREE.Mesh | null = null;
  let wheelNodes: Record<LabWheelId, Wheel3DNodes> | null = null;
  let velArrow: Arrow3D | null = null;
  let netArrow: Arrow3D | null = null;
  let yawArcLine: THREE.Line | null = null;
  let yawArcPositions: Float32Array | null = null;
  let yawArcCone: THREE.Mesh | null = null;
  let builtGeomSignature = '';

  // -------------------------------------------------------------------------
  // DOM Layout (~74% Three.js Canvas Stage + ~26% HUD & Input Bars)
  // -------------------------------------------------------------------------
  const root = el('div', 'view3d-lab');
  const stageWrap = el('div', 'view3d-lab__stage lab-card');
  const stageBadge = el(
    'div',
    'view3d-lab__hint',
    'Arrastar: orbitar · Roda: zoom · C: Chase · P: Iso/Persp',
  );
  stageWrap.append(stageBadge);

  const hudAside = el('aside', 'view3d-lab__hud lab-card');
  const hudTitle = el('div', 'view3d-hud__title', '3D ISOMÉTRICO');
  const hudSub = el('div', 'view3d-hud__sub', 'Sem sessão carregada');

  const hudStats = el('div', 'view3d-hud__stats tabular-nums');
  const statTime = el('div', 'view3d-hud__line', 't = 0.00 s');
  const statSpeed = el('div', 'view3d-hud__line', 'vel 0.0 m/s (0 km/h)');
  const statRoll = el('div', 'view3d-hud__line', 'roll +0.00° (+ dir. em baixo)');
  const statPitch = el('div', 'view3d-hud__line', 'pitch +0.00° (+ nariz em baixo)');
  const statYawM = el('div', 'view3d-hud__line', 'momento +0.00 kN·m (+ esq.)');
  const statExag = el('div', 'view3d-hud__note', `movimento carroceria ×${exaggerate}`);
  hudStats.append(statTime, statSpeed, statRoll, statPitch, statYawM, statExag);

  const wheelTable = el('div', 'view3d-hud__wheels tabular-nums');
  const wheelRowEls = {} as Record<LabWheelId, HTMLDivElement>;
  for (const id of LAB_WHEEL_IDS) {
    const row = el('div', 'view3d-hud__wheel-row', `${id}  Fz     0 N    0%`);
    wheelRowEls[id] = row;
    wheelTable.append(row);
  }

  const legendBlock = el('div', 'view3d-hud__legend');
  const legendScaleLine = el('div', 'view3d-hud__legend-scale tabular-nums', 'forças: 1 m = — kN');
  legendBlock.append(
    legendScaleLine,
    createLegendLine('#3b82f6', 'azul · carga vertical Fz'),
    createLegendLine('#f8fafc', 'branco · força pneu (Fx, Fy)'),
    createLegendLine('#10b981', 'disco · aderência μ·Fz (% uso)'),
    createLegendLine('#f97316', 'laranja · resultante 4 pneus'),
    createLegendLine('#a855f7', 'roxo · momento guinada (arco)'),
    createLegendLine('#34d399', 'verde · velocidade (0.15 s)'),
    createLegendLine('#94a3b8', 'molas: azul aliviada ↔ verm. carregada'),
  );

  // Driver inputs (input_bars.py style at bottom of HUD)
  const hudInputs = el('div', 'view3d-hud__inputs');
  const pedalsWrap = el('div', 'lab-pedals');
  const throttleBar = createVerticalInputBar('Acel.', 'lab-bar-fill--throttle');
  const brakeBar = createVerticalInputBar('Trav.', 'lab-bar-fill--brake');
  pedalsWrap.append(throttleBar.root, brakeBar.root);

  const steerWrap = el('div', 'lab-steer');
  const steerHead = el('div', 'lab-steer__header');
  steerHead.append(el('span', 'lab-steer__label', 'DIREÇÃO'));
  const steerValEl = el('span', 'lab-steer__val tabular-nums', '+0.0°');
  steerHead.append(steerValEl);
  const steerTrack = el('div', 'lab-steer__track');
  const steerZero = el('div', 'lab-steer__zero');
  const steerFill = el('div', 'lab-steer__fill');
  steerTrack.append(steerZero, steerFill);
  steerWrap.append(steerHead, steerTrack);
  hudInputs.append(pedalsWrap, steerWrap);

  hudAside.append(hudTitle, hudSub, hudStats, wheelTable, legendBlock, hudInputs);
  root.append(stageWrap, hudAside);
  options.container.append(root);

  // -------------------------------------------------------------------------
  // Orbit & Zoom Pointer Interactions (disabled during Chase)
  // -------------------------------------------------------------------------
  let isDragging = false;
  let lastPtrX = 0;
  let lastPtrY = 0;

  const onPointerDown = (e: PointerEvent) => {
    if (chase || e.button !== 0) return;
    isDragging = true;
    lastPtrX = e.clientX;
    lastPtrY = e.clientY;
    stageWrap.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: PointerEvent) => {
    if (!isDragging || chase) return;
    const dx = e.clientX - lastPtrX;
    const dy = e.clientY - lastPtrY;
    lastPtrX = e.clientX;
    lastPtrY = e.clientY;

    azimRad -= dx * 0.0085;
    elevRad = Math.max(5 * DEG_TO_RAD, Math.min(85 * DEG_TO_RAD, elevRad + dy * 0.0075));
    renderCurrent();
  };
  const onPointerUp = (e: PointerEvent) => {
    if (!isDragging) return;
    isDragging = false;
    if (stageWrap.hasPointerCapture(e.pointerId)) {
      stageWrap.releasePointerCapture(e.pointerId);
    }
  };
  const onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.08 : 1 / 1.08;
    zoomScale = Math.max(0.45, Math.min(3.0, zoomScale * factor));
    renderCurrent();
  };

  stageWrap.addEventListener('pointerdown', onPointerDown);
  stageWrap.addEventListener('pointermove', onPointerMove);
  stageWrap.addEventListener('pointerup', onPointerUp);
  stageWrap.addEventListener('pointercancel', onPointerUp);
  stageWrap.addEventListener('wheel', onWheel, { passive: false });

  // -------------------------------------------------------------------------
  // Lazy Three.js Scene & Renderer Construction
  // -------------------------------------------------------------------------
  function rebuildVehicleGeometry(specs: ResolvedVehicleSpecs): void {
    if (!scene) return;
    const L = Math.max(1.5, specs.wheelbaseL || 2.65);
    const lr = L * specs.frontWeightRatio;
    const lf = L - lr;
    const tf = Math.max(1.0, specs.trackF || 1.55);
    const tr = Math.max(1.0, specs.trackR || 1.55);
    const cgZ = Math.max(0.25, specs.cgHeight || 0.54);
    const r = Math.max(0.15, specs.tireRadiusM || 0.316);
    const sig = `${lf.toFixed(3)}:${lr.toFixed(3)}:${tf.toFixed(3)}:${tr.toFixed(3)}:${cgZ.toFixed(3)}:${r.toFixed(3)}`;
    if (sig === builtGeomSignature && chassisGroup) return;
    builtGeomSignature = sig;

    if (chassisGroup) {
      scene.remove(chassisGroup);
      disposeObjectTree(chassisGroup);
    }

    chassisGroup = new THREE.Group();
    chassisGroup.rotation.order = 'ZYX';

    const frontX = lf + OVERHANG_M;
    const rearX = -(lr + OVERHANG_M);
    const bodyLen = frontX - rearX;
    const bodyCenterX = 0.5 * (frontX + rearX);
    const bodyWidth = Math.max(tf, tr) + BODY_WIDTH_MARGIN_M * 2;
    const bottomZ = -cgZ + r + 0.05;
    const bodyHeight = Math.max(0.25, BODY_TOP_M - bottomZ);
    const bodyCenterZ = bottomZ + bodyHeight * 0.5;

    const boxGeo = new THREE.BoxGeometry(bodyLen, bodyWidth, bodyHeight);
    const boxMat = new THREE.MeshBasicMaterial({
      color: 0x64748b,
      transparent: true,
      opacity: 0.18,
      depthWrite: false,
    });
    const boxMesh = new THREE.Mesh(boxGeo, boxMat);
    boxMesh.position.set(bodyCenterX, 0, bodyCenterZ);
    boxMesh.renderOrder = 4;

    const edgesGeo = new THREE.EdgesGeometry(boxGeo);
    const edgesMat = new THREE.LineBasicMaterial({
      color: 0x94a3b8,
      transparent: true,
      opacity: 0.85,
    });
    const edgesLine = new THREE.LineSegments(edgesGeo, edgesMat);
    edgesLine.position.copy(boxMesh.position);
    edgesLine.renderOrder = 5;

    // Bright cyan front nose bar
    const noseGeo = new THREE.BoxGeometry(0.06, bodyWidth * 0.84, 0.08);
    const noseMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
    const noseMesh = new THREE.Mesh(noseGeo, noseMat);
    noseMesh.position.set(frontX - 0.02, 0, bottomZ + 0.14);
    noseMesh.renderOrder = 5;

    chassisGroup.add(boxMesh, edgesLine, noseMesh);
    scene.add(chassisGroup);

    // Update wheel ring radius if wheelNodes exist
    if (wheelNodes) {
      for (const id of LAB_WHEEL_IDS) {
        const wn = wheelNodes[id];
        wn.ringMesh.geometry.dispose();
        wn.ringMesh.geometry = new THREE.TorusGeometry(r, 0.038, 10, 32);
        wn.ringMesh.geometry.rotateX(Math.PI / 2);

        const spokePos = wn.spokeLine.geometry.getAttribute('position') as THREE.BufferAttribute;
        spokePos.setXYZ(0, 0, 0, 0);
        spokePos.setXYZ(1, 0, 0, r);
        spokePos.needsUpdate = true;
      }
    }
  }

  function ensureRenderer(): boolean {
    if (renderer && scene && orthoCam && perspCam) return true;
    if (typeof document === 'undefined') return false;

    const rect = stageWrap.getBoundingClientRect();
    const w = Math.max(120, Math.floor(rect.width));
    const h = Math.max(120, Math.floor(rect.height));

    scene = new THREE.Scene();
    scene.background = new THREE.Color(0x070c18);

    const aspect = w / h;
    const halfView = 4.2;
    orthoCam = new THREE.OrthographicCamera(
      -halfView * aspect,
      halfView * aspect,
      halfView,
      -halfView,
      -80,
      120,
    );
    orthoCam.up.set(0, 0, 1);

    perspCam = new THREE.PerspectiveCamera(38, aspect, 0.1, 160);
    perspCam.up.set(0, 0, 1);

    renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.setSize(w, h);
    renderer.domElement.className = 'view3d-lab__canvas';
    stageWrap.insertBefore(renderer.domElement, stageBadge);

    // Moving 2 m ground grid
    groundGrid = buildGroundGrid();
    groundGrid.renderOrder = 1;
    scene.add(groundGrid);

    // Pre-allocated 4.0 s trail behind car (zero GC churn)
    trailPositions = new Float32Array(MAX_TRAIL_VERTICES * 3);
    const trailGeo = new THREE.BufferGeometry();
    trailGeo.setAttribute('position', new THREE.BufferAttribute(trailPositions, 3));
    trailGeo.setDrawRange(0, 0);
    const trailMat = new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.72 });
    trailLine = new THREE.Line(trailGeo, trailMat);
    trailLine.frustumCulled = false;
    trailLine.renderOrder = 2;
    scene.add(trailLine);

    // CG dot
    cgDot = new THREE.Mesh(
      new THREE.SphereGeometry(0.065, 14, 14),
      new THREE.MeshBasicMaterial({ color: 0xf8fafc, depthTest: false }),
    );
    cgDot.renderOrder = 15;
    scene.add(cgDot);

    // 4 wheels, struts, grip discs, Fz vertical arrows, horizontal tire force arrows
    const r = session?.vehicleSpecs.tireRadiusM ?? 0.316;
    const strutGeo = new THREE.CylinderGeometry(0.032, 0.032, 1, 8);
    strutGeo.rotateX(Math.PI / 2);
    const discGeo = new THREE.CircleGeometry(1, 48);
    const discBorderGeo = buildWheelRingGeometry(1);
    discBorderGeo.rotateX(Math.PI / 2); // lie flat in XY plane

    wheelNodes = {} as Record<LabWheelId, Wheel3DNodes>;
    for (const id of LAB_WHEEL_IDS) {
      const strutMat = new THREE.MeshBasicMaterial({ color: 0xe2e8f0 });
      const strut = new THREE.Mesh(strutGeo, strutMat);
      strut.renderOrder = 6;
      scene.add(strut);

      const wheelGroup = new THREE.Group();
      const ringGeo = new THREE.TorusGeometry(r, 0.038, 10, 32);
      ringGeo.rotateX(Math.PI / 2); // ring stands vertically in XZ plane
      const ringMat = new THREE.MeshBasicMaterial({ color: 0x10b981 });
      const ringMesh = new THREE.Mesh(ringGeo, ringMat);
      ringMesh.renderOrder = 7;

      const spokeGeo = new THREE.BufferGeometry();
      spokeGeo.setAttribute(
        'position',
        new THREE.Float32BufferAttribute([0, 0, 0, 0, 0, r], 3),
      );
      const spokeMat = new THREE.LineBasicMaterial({ color: 0xf8fafc });
      const spokeLine = new THREE.Line(spokeGeo, spokeMat);
      spokeLine.renderOrder = 8;

      wheelGroup.add(ringMesh, spokeLine);
      scene.add(wheelGroup);

      const discMat = new THREE.MeshBasicMaterial({
        color: 0x10b981,
        transparent: true,
        opacity: 0.28,
        depthWrite: false,
        side: THREE.DoubleSide,
      });
      const discMesh = new THREE.Mesh(discGeo, discMat);
      discMesh.renderOrder = 3;
      scene.add(discMesh);

      const discBorderMat = new THREE.LineBasicMaterial({
        color: 0x94a3b8,
        transparent: true,
        opacity: 0.72,
      });
      const discBorder = new THREE.LineLoop(discBorderGeo, discBorderMat);
      discBorder.renderOrder = 3;
      scene.add(discBorder);

      const fzArrow = createArrow3D(0x3b82f6, 0.032, 0.075, 0.17, 11);
      const forceArrow = createArrow3D(0xf8fafc, 0.032, 0.08, 0.18, 12);
      scene.add(fzArrow.group, forceArrow.group);

      wheelNodes[id] = {
        strut,
        strutMat,
        wheelGroup,
        ringMesh,
        ringMat,
        spokeLine,
        discMesh,
        discMat,
        discBorder,
        fzArrow,
        forceArrow,
      };
    }

    // CG velocity (green) & net force (orange) arrows
    velArrow = createArrow3D(0x10b981, 0.03, 0.075, 0.17, 13);
    netArrow = createArrow3D(0xf97316, 0.04, 0.095, 0.21, 14);
    scene.add(velArrow.group, netArrow.group);

    // Pre-allocated purple yaw_moment arc around CG + directional cone tip
    yawArcPositions = new Float32Array(YAW_ARC_SAMPLES * 3);
    const arcGeo = new THREE.BufferGeometry();
    arcGeo.setAttribute('position', new THREE.BufferAttribute(yawArcPositions, 3));
    const arcMat = new THREE.LineBasicMaterial({ color: 0xa855f7, depthTest: false });
    yawArcLine = new THREE.Line(arcGeo, arcMat);
    yawArcLine.frustumCulled = false;
    yawArcLine.renderOrder = 14;
    yawArcLine.visible = false;

    const coneGeo = new THREE.ConeGeometry(0.085, 0.24, 12);
    coneGeo.rotateX(Math.PI / 2);
    yawArcCone = new THREE.Mesh(
      coneGeo,
      new THREE.MeshBasicMaterial({ color: 0xa855f7, depthTest: false }),
    );
    yawArcCone.renderOrder = 14;
    yawArcCone.visible = false;
    scene.add(yawArcLine, yawArcCone);

    if (session) {
      rebuildVehicleGeometry(session.vehicleSpecs);
    }

    return true;
  }

  function resizeRenderer(force: boolean = false): void {
    if (!renderer || !orthoCam || !perspCam) return;
    if (!force && cachedStageW > 0 && cachedStageH > 0 && cachedZoom === zoomScale) {
      return;
    }
    const rect = stageWrap.getBoundingClientRect();
    const w = Math.max(80, Math.floor(rect.width));
    const h = Math.max(80, Math.floor(rect.height));
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const aspect = w / h;

    if (w !== cachedStageW || h !== cachedStageH || dpr !== cachedDpr) {
      renderer.setPixelRatio(dpr);
      renderer.setSize(w, h);
      cachedStageW = w;
      cachedStageH = h;
      cachedDpr = dpr;
    }
    cachedZoom = zoomScale;

    const halfView = 4.0 * zoomScale;
    orthoCam.left = -halfView * aspect;
    orthoCam.right = halfView * aspect;
    orthoCam.top = halfView;
    orthoCam.bottom = -halfView;
    orthoCam.updateProjectionMatrix();

    perspCam.aspect = aspect;
    perspCam.updateProjectionMatrix();
  }

  let resizeObserver: ResizeObserver | null = null;
  if (typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver(() => {
      if (root.offsetWidth > 0 && root.offsetHeight > 0 && renderer) {
        resizeRenderer(true);
        renderCurrent();
      }
    });
    resizeObserver.observe(stageWrap);
  }

  // -------------------------------------------------------------------------
  // 60 FPS In-Place Scene Update & HUD Sync
  // -------------------------------------------------------------------------
  function updateSceneAndHud(tSec: number, frame: SampleFrame | null, dtSec: number): void {
    if (!session || !frame) return;
    if (root.offsetWidth <= 0 || root.offsetHeight <= 0) return;
    if (!ensureRenderer() || !renderer || !scene || !orthoCam || !perspCam || !wheelNodes) return;

    const { vehicleSpecs, kammLimits, scales, track } = session;
    const dyn = computeLabFrameDynamics(frame, vehicleSpecs, kammLimits, scales);
    const k = scales.forceScale;
    const r = dyn.tireRadiusM;
    const cgZ = dyn.cgHeight;

    // Accumulate wheel spin θ = ∫ (u / R) dt
    if (Number.isFinite(dtSec) && dtSec > 0 && Number.isFinite(frame.speedMs)) {
      wheelSpinRad += (frame.speedMs / r) * dtSec;
    }

    // 1. Moving 2 m grid anchored to car position modulo 2 m
    if (groundGrid) {
      const modX = ((frame.x % GRID_STEP_M) + GRID_STEP_M) % GRID_STEP_M;
      const modY = ((frame.y % GRID_STEP_M) + GRID_STEP_M) % GRID_STEP_M;
      groundGrid.position.set(-modX, -modY, 0);
    }

    // 2. 4.0 s trail behind car (car at local origin (0, 0))
    if (trailLine && trailPositions && track.length > 0) {
      const endIdx = findTrackIndexAtOrBefore(track.t, tSec);
      const minTime = tSec - TRAIL_3D_SEC;
      let startIdx = endIdx;
      while (startIdx > 0 && (track.t[startIdx - 1] ?? 0) >= minTime) {
        if (((track.flags[startIdx] ?? 0) & TRACK_FLAG.IS_GAP) !== 0) break;
        startIdx -= 1;
      }

      const rawSpan = endIdx - startIdx + 1;
      const step = Math.max(1, Math.ceil(rawSpan / (MAX_TRAIL_VERTICES - 1)));
      let outCount = 0;
      for (let i = startIdx; i <= endIdx && outCount < MAX_TRAIL_VERTICES - 1; i += step) {
        const px = (track.x[i] ?? frame.x) - frame.x;
        const py = (track.y[i] ?? frame.y) - frame.y;
        trailPositions[outCount * 3] = px;
        trailPositions[outCount * 3 + 1] = py;
        trailPositions[outCount * 3 + 2] = 0.005;
        outCount += 1;
      }
      trailPositions[outCount * 3] = 0;
      trailPositions[outCount * 3 + 1] = 0;
      trailPositions[outCount * 3 + 2] = 0.005;
      outCount += 1;

      trailLine.geometry.setDrawRange(0, outCount);
      (trailLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }

    // 3. Chassis pose: exact ISO 8855 Rz(yaw) * Ry(exaggerate * pitch) * Rx(exaggerate * roll)
    if (chassisGroup) {
      chassisGroup.position.set(0, 0, cgZ);
      chassisGroup.rotation.set(
        frame.rollRad * exaggerate,
        frame.pitchRad * exaggerate,
        frame.yaw,
        'ZYX',
      );
      chassisGroup.updateMatrix();
    }
    if (cgDot) {
      cgDot.position.set(0, 0, cgZ);
    }

    const cosY = Math.cos(frame.yaw);
    const sinY = Math.sin(frame.yaw);

    // 4. 4 Struts, Wheels, Grip Discs, Fz Arrows, Tire Force Arrows
    const bodyStrutLocalZ = -cgZ + r + STRUT_LENGTH_M;
    for (const id of LAB_WHEEL_IDS) {
      const wd = dyn.wheels[id];
      const wn = wheelNodes[id];
      const isFront = id === 'FL' || id === 'FR';
      const wHeading = frame.yaw + (isFront ? dyn.steerRad : 0);
      const wLeftX = -Math.sin(wHeading);
      const wLeftY = Math.cos(wHeading);

      // Rotated strut top attachment on body
      TEMP_LOCAL.set(wd.wx, wd.wy, bodyStrutLocalZ);
      if (chassisGroup) {
        TEMP_TOP.copy(TEMP_LOCAL).applyEuler(chassisGroup.rotation);
        TEMP_TOP.z += cgZ;
      } else {
        TEMP_TOP.set(wd.wx * cosY - wd.wy * sinY, wd.wx * sinY + wd.wy * cosY, r + STRUT_LENGTH_M);
      }

      const patchX = TEMP_TOP.x;
      const patchY = TEMP_TOP.y;
      TEMP_HUB.set(patchX, patchY, r);

      // Strut cylinder between hub and body top, colored with coolwarm
      TEMP_DIR.subVectors(TEMP_TOP, TEMP_HUB);
      const strutLen = TEMP_DIR.length();
      if (strutLen > 1e-4) {
        TEMP_MID.addVectors(TEMP_HUB, TEMP_TOP).multiplyScalar(0.5);
        wn.strut.position.copy(TEMP_MID);
        TEMP_DIR.multiplyScalar(1 / strutLen);
        TEMP_QUAT.setFromUnitVectors(UP_Z, TEMP_DIR);
        wn.strut.quaternion.copy(TEMP_QUAT);
        wn.strut.scale.set(1, 1, strutLen);
        wn.strutMat.color.set(coolwarmColorHex(wd.strutRatio));
      }

      // Wheel at contact patch (center at z = r), turned by yaw + steer, spoke at π/2 - spin
      const colHex = wd.fz > 0 ? gripColorHex(wd.gripUse) : '#64748b';
      wn.wheelGroup.position.set(patchX, patchY, r);
      wn.wheelGroup.rotation.set(0, 0, wHeading);
      wn.ringMat.color.set(colHex);

      const spokeAngle = Math.PI * 0.5 - wheelSpinRad;
      const spokePos = wn.spokeLine.geometry.getAttribute('position') as THREE.BufferAttribute;
      spokePos.setXYZ(0, 0, 0, 0);
      spokePos.setXYZ(1, Math.cos(spokeAngle) * r, 0, Math.sin(spokeAngle) * r);
      spokePos.needsUpdate = true;

      // Grip disc at z = 0.004 (radius = grip * forceScale)
      const discR = wd.grip * k;
      if (wd.fz > 0 && discR > 0.01) {
        wn.discMesh.visible = true;
        wn.discBorder.visible = true;
        wn.discMesh.position.set(patchX, patchY, 0.004);
        wn.discMesh.scale.set(discR, discR, 1);
        wn.discMat.color.set(colHex);
        wn.discBorder.position.set(patchX, patchY, 0.006);
        wn.discBorder.scale.set(discR, discR, 1);
      } else {
        wn.discMesh.visible = false;
        wn.discBorder.visible = false;
      }

      // Outboard vertical blue Fz arrow (±LOAD_OFFSET_M along wheel left)
      const sideSign = wd.wy >= 0 ? 1 : -1;
      const fzOx = patchX + wLeftX * LOAD_OFFSET_M * sideSign;
      const fzOy = patchY + wLeftY * LOAD_OFFSET_M * sideSign;
      setArrowVector(wn.fzArrow, fzOx, fzOy, 0, 0, 0, wd.fz * k);

      // Horizontal white tire force arrow (fx, fy) in world frame at z = 0.015
      const fxWorld = (wd.fx * cosY - wd.fy * sinY) * k;
      const fyWorld = (wd.fx * sinY + wd.fy * cosY) * k;
      setArrowVector(wn.forceArrow, patchX, patchY, 0.015, fxWorld, fyWorld, 0);
    }

    // 5. CG Velocity (green), Net Force (orange) & Yaw Moment Arc (purple)
    if (velArrow) {
      setArrowVector(
        velArrow,
        0,
        0,
        cgZ,
        frame.speedMs * cosY * VELOCITY_TIME_S,
        frame.speedMs * sinY * VELOCITY_TIME_S,
        0,
      );
    }
    if (netArrow) {
      setArrowVector(
        netArrow,
        0,
        0,
        cgZ,
        (dyn.netFx * cosY - dyn.netFy * sinY) * k,
        (dyn.netFx * sinY + dyn.netFy * cosY) * k,
        0,
      );
    }

    if (yawArcLine && yawArcPositions && yawArcCone) {
      if (dyn.momentShare > 0.02) {
        const turn = dyn.yawMoment >= 0 ? 1 : -1;
        const sweep = YAW_ARC_MAX_SWEEP_RAD * dyn.momentShare;
        let endAngle = frame.yaw;
        for (let i = 0; i < YAW_ARC_SAMPLES; i++) {
          const frac = i / (YAW_ARC_SAMPLES - 1);
          const a = frame.yaw + turn * (-sweep * 0.5 + frac * sweep);
          endAngle = a;
          yawArcPositions[i * 3] = YAW_ARC_RADIUS_M * Math.cos(a);
          yawArcPositions[i * 3 + 1] = YAW_ARC_RADIUS_M * Math.sin(a);
          yawArcPositions[i * 3 + 2] = cgZ;
        }
        (yawArcLine.geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
        yawArcLine.visible = true;

        const ex = YAW_ARC_RADIUS_M * Math.cos(endAngle);
        const ey = YAW_ARC_RADIUS_M * Math.sin(endAngle);
        const tx = turn * -Math.sin(endAngle);
        const ty = turn * Math.cos(endAngle);
        yawArcCone.position.set(ex + tx * 0.08, ey + ty * 0.08, cgZ);
        TEMP_DIR.set(tx, ty, 0);
        TEMP_QUAT.setFromUnitVectors(UP_Z, TEMP_DIR);
        yawArcCone.quaternion.copy(TEMP_QUAT);
        yawArcCone.visible = true;
      } else {
        yawArcLine.visible = false;
        yawArcCone.visible = false;
      }
    }

    // 6. Camera positioning (Isometric Ortho vs Perspective + Chase lock from view3d.py L323)
    if (chase) {
      azimRad = isometric
        ? frame.yaw + Math.PI + ISO_AZIM_RAD + Math.PI / 4
        : frame.yaw + Math.PI;
    }

    const activeCam = isometric ? orthoCam : perspCam;
    const dist = isometric ? 22 : 9.2 * zoomScale;
    const cosE = Math.cos(elevRad);
    const sinE = Math.sin(elevRad);
    const camX = dist * cosE * Math.cos(azimRad);
    const camY = dist * cosE * Math.sin(azimRad);
    const camZ = cgZ * 0.7 + dist * sinE;

    resizeRenderer();
    activeCam.position.set(camX, camY, camZ);
    activeCam.lookAt(0, 0, cgZ * 0.65);
    renderer.render(scene, activeCam);

    // 7. Update right-side HUD & Input bars (100% textContent)
    statTime.textContent = `t = ${tSec.toFixed(2)} s`;
    statSpeed.textContent = `vel ${frame.speedMs.toFixed(1)} m/s (${(frame.speedMs * 3.6).toFixed(0)} km/h)`;
    const rollDeg = frame.rollRad * RAD_TO_DEG;
    const pitchDeg = frame.pitchRad * RAD_TO_DEG;
    statRoll.textContent = `roll ${rollDeg >= 0 ? '+' : ''}${rollDeg.toFixed(2)}° (+ dir. em baixo)`;
    statPitch.textContent = `pitch ${pitchDeg >= 0 ? '+' : ''}${pitchDeg.toFixed(2)}° (+ nariz em baixo)`;
    statYawM.textContent = `momento ${dyn.yawMoment >= 0 ? '+' : ''}${(dyn.yawMoment / 1000).toFixed(2)} kN·m (+ esq.)`;
    statExag.textContent = `movimento carroceria ×${exaggerate.toFixed(1).replace(/\.0$/, '')}`;
    legendScaleLine.textContent = `forças: 1 m = ${(1 / (k * 1000)).toFixed(1)} kN`;

    for (const id of LAB_WHEEL_IDS) {
      const wd = dyn.wheels[id];
      const row = wheelRowEls[id];
      const fzStr = String(Math.round(wd.fz)).padStart(5, ' ');
      const pctStr = String(Math.round(wd.gripUse * 100)).padStart(3, ' ');
      row.textContent = `${id}  Fz ${fzStr} N  ${pctStr}%${wd.stateLabel ? ` ${wd.stateLabel}` : ''}`;
      row.style.color = wd.fz > 0 ? gripColorHex(wd.gripUse) : '#94a3b8';
    }

    const thrPct = Math.round(dyn.throttle * 100);
    const brkPct = Math.round(dyn.brake * 100);
    const steerDeg = dyn.steerRad * RAD_TO_DEG;
    throttleBar.fill.style.height = `${thrPct}%`;
    throttleBar.val.textContent = `${thrPct}%`;
    brakeBar.fill.style.height = `${brkPct}%`;
    brakeBar.val.textContent = `${brkPct}%`;

    const halfPct = Math.abs(dyn.steerNorm) * 50;
    if (dyn.steerNorm >= 0) {
      steerFill.style.left = `${50 - halfPct}%`;
      steerFill.style.width = `${halfPct}%`;
    } else {
      steerFill.style.left = '50%';
      steerFill.style.width = `${halfPct}%`;
    }
    steerValEl.textContent = `${steerDeg >= 0 ? '+' : ''}${steerDeg.toFixed(1)}°`;
  }

  function renderCurrent(): void {
    updateSceneAndHud(lastTimeSec, lastFrame, 0);
  }

  function setSessionData(data: View3dLabSessionData): void {
    session = data;
    wheelSpinRad = 0;
    hudTitle.textContent = data.vehicleSpecs.name;
    hudSub.textContent = data.sessionLabel;
    if (scene) {
      rebuildVehicleGeometry(data.vehicleSpecs);
    }
    renderCurrent();
  }

  function setIsometric(nextIso: boolean): void {
    isometric = nextIso;
    if (isometric) {
      elevRad = ISO_ELEV_RAD;
      azimRad = ISO_AZIM_RAD;
    } else {
      elevRad = PERSP_DEFAULT_ELEV_RAD;
      azimRad = PERSP_DEFAULT_AZIM_RAD;
    }
    options.onCameraStateChange?.();
    renderCurrent();
  }

  function setChase(nextChase: boolean): void {
    chase = nextChase;
    options.onCameraStateChange?.();
    renderCurrent();
  }

  function resetCamera(): void {
    chase = false;
    zoomScale = 1.0;
    elevRad = isometric ? ISO_ELEV_RAD : PERSP_DEFAULT_ELEV_RAD;
    azimRad = isometric ? ISO_AZIM_RAD : PERSP_DEFAULT_AZIM_RAD;
    options.onCameraStateChange?.();
    renderCurrent();
  }

  function dispose(): void {
    resizeObserver?.disconnect();
    resizeObserver = null;
    stageWrap.removeEventListener('pointerdown', onPointerDown);
    stageWrap.removeEventListener('pointermove', onPointerMove);
    stageWrap.removeEventListener('pointerup', onPointerUp);
    stageWrap.removeEventListener('pointercancel', onPointerUp);
    stageWrap.removeEventListener('wheel', onWheel);

    if (scene) {
      disposeObjectTree(scene);
      scene = null;
    }
    if (renderer) {
      renderer.dispose();
      renderer.domElement.remove();
      renderer = null;
    }
    orthoCam = null;
    perspCam = null;
    wheelNodes = null;
    root.remove();
  }

  return {
    element: root,
    setSessionData,
    setExaggerate: (nextExag: number) => {
      exaggerate = Math.max(0.5, Math.min(8, nextExag));
      renderCurrent();
    },
    getExaggerate: () => exaggerate,
    setIsometric,
    isIsometric: () => isometric,
    setChase,
    isChase: () => chase,
    resetCamera,
    updateFrame: (tSec, frame, dtSec) => {
      lastTimeSec = tSec;
      lastFrame = frame;
      updateSceneAndHud(tSec, frame, dtSec);
    },
    resize: () => {
      resizeRenderer(true);
      renderCurrent();
    },
    dispose,
  };
}

function createLegendLine(color: string, text: string): HTMLElement {
  const row = el('div', 'view3d-hud__legend-line');
  const dot = el('span', 'view3d-hud__legend-dot');
  dot.style.backgroundColor = color;
  row.append(dot, el('span', undefined, text));
  return row;
}

function createVerticalInputBar(
  label: string,
  fillModifierClass: string,
): { root: HTMLElement; fill: HTMLElement; val: HTMLElement } {
  const root = el('div', 'lab-pedal');
  const val = el('span', 'lab-pedal__val tabular-nums', '0%');
  const track = el('div', 'lab-pedal__track');
  const fill = el('div', `lab-pedal__fill ${fillModifierClass}`);
  fill.style.height = '0%';
  track.append(fill);
  const lbl = el('span', 'lab-pedal__label', label);
  root.append(val, track, lbl);
  return { root, fill, val };
}

function disposeObjectTree(obj: THREE.Object3D): void {
  const geometries = new Set<THREE.BufferGeometry>();
  const materials = new Set<THREE.Material>();

  obj.traverse((child) => {
    if (
      child instanceof THREE.Mesh ||
      child instanceof THREE.Line ||
      child instanceof THREE.LineSegments ||
      child instanceof THREE.LineLoop
    ) {
      geometries.add(child.geometry);
      if (Array.isArray(child.material)) {
        for (const m of child.material) materials.add(m);
      } else {
        materials.add(child.material);
      }
    }
  });

  for (const g of geometries) g.dispose();
  for (const m of materials) m.dispose();
}
