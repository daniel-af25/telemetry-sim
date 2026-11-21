/**
 * Abstração `VehicleRig` + implementação procedural 3D (`createProceduralVehicleRig`)
 * em Three.js com convenção ISO 8855 (`+X` frente, `+Y` esquerda, `+Z` cima),
 * assentamento exato em `z = 0` (base da banda de rodagem dos 4 pneus), direção nas
 * mangas dianteiras, rotação acumulada `∫(u/R)dt`, suspensão exagerada `Rz Ry Rx`
 * (idêntica a `view3d.py`) e vetores opcionais de carga `Fz` + discos de aderência.
 *
 * Testes:
 *   npx vitest run test/ui/vehicleRig.test.ts
 */
import * as THREE from 'three';
import type { SampleFrame } from '../core/interpolator.ts';
import type { ResolvedVehicleSpecs } from '../core/vehicleSpecs.ts';
import { RDYLGN_R_PALETTE } from './mapView.ts';

const GRAVITY_MS2 = 9.80665;
const DEFAULT_EXAGGERATE = 4.0;
const OVERHANG_FRONT_M = 0.62;
const OVERHANG_REAR_M = 0.58;
const BODY_WIDTH_MARGIN_M = 0.14;
const TIRE_WIDTH_M = 0.22;
const FORCE_ARROW_MAX_M = 1.65;
const ACCEL_DEADZONE_G = 0.03;
const ACCEL_NET_DEADZONE_G = 0.04;
const ACCEL_SCALE_M_PER_G = 3.0;
const ACCEL_ARROW_MAX_M = 2.6;
const ACCEL_NET_ARROW_MAX_M = 3.0;

interface HorizontalArrowNodes {
  group: THREE.Group;
  shaft: THREE.Mesh;
  cone: THREE.Mesh;
  material: THREE.MeshBasicMaterial;
  coneHeight: number;
}

function createHorizontalArrow(
  name: string,
  colorHex: number,
  shaftRadius: number,
  coneRadius: number,
  coneHeight: number,
): HorizontalArrowNodes {
  const group = new THREE.Group();
  group.name = name;
  group.visible = false;

  const material = new THREE.MeshBasicMaterial({
    color: colorHex,
    transparent: true,
    opacity: 0.92,
  });

  // CylinderGeometry axis is +Y; rotate -PI/2 around Z so axis aligns with +X (ISO 8855 forward)
  const shaftGeo = new THREE.CylinderGeometry(shaftRadius, shaftRadius, 1.0, 12);
  shaftGeo.rotateZ(-Math.PI / 2);
  shaftGeo.translate(0.5, 0, 0);
  const shaft = new THREE.Mesh(shaftGeo, material);
  shaft.name = `${name}_shaft`;

  const coneGeo = new THREE.ConeGeometry(coneRadius, coneHeight, 14);
  coneGeo.rotateZ(-Math.PI / 2);
  const cone = new THREE.Mesh(coneGeo, material);
  cone.name = `${name}_cone`;
  cone.position.set(1.0 + coneHeight * 0.5, 0, 0);

  group.add(shaft, cone);
  return { group, shaft, cone, material, coneHeight };
}

export interface VehicleRigUpdateOptions {
  dtSec?: number;
  exaggerate?: number;
  showForceVectors?: boolean;
}

export interface VehicleRig {
  getObject3D(): THREE.Group;
  updatePose(
    frame: SampleFrame,
    specs: ResolvedVehicleSpecs,
    opts?: VehicleRigUpdateOptions,
  ): void;
  getWheelSpinRad(): number;
  dispose(): void;
}

type WheelId = 'FL' | 'FR' | 'RL' | 'RR';

interface WheelNodes {
  knuckle: THREE.Group;
  wheel: THREE.Group;
  fzBar: THREE.Mesh;
  fzCone: THREE.Mesh;
  gripDisc: THREE.Mesh;
  gripMat: THREE.MeshBasicMaterial;
}

function colorForUtilization(ratio: number): string {
  const clamped = Math.max(0, Math.min(1, Number.isFinite(ratio) ? ratio : 0));
  const idx = Math.min(
    RDYLGN_R_PALETTE.length - 1,
    Math.floor(clamped * (RDYLGN_R_PALETTE.length - 1) + 1e-9),
  );
  return RDYLGN_R_PALETTE[idx] ?? '#10b981';
}

function createWheelVisual(
  radiusM: number,
  tireMat: THREE.Material,
  rimMat: THREE.Material,
  spokeMat: THREE.Material,
): THREE.Group {
  const wheelGroup = new THREE.Group();

  // CylinderGeometry axis is +Y, which matches the ISO 8855 left-right wheel axle directly
  const tireGeo = new THREE.CylinderGeometry(radiusM, radiusM, TIRE_WIDTH_M, 24);
  const tireMesh = new THREE.Mesh(tireGeo, tireMat);
  wheelGroup.add(tireMesh);

  const rimRadius = radiusM * 0.62;
  const rimGeo = new THREE.CylinderGeometry(rimRadius, rimRadius, TIRE_WIDTH_M + 0.012, 16);
  const rimMesh = new THREE.Mesh(rimGeo, rimMat);
  wheelGroup.add(rimMesh);

  // High-contrast radial spoke bar to make wheel spin (u / R) clearly visible
  const spokeGeo = new THREE.BoxGeometry(rimRadius * 1.82, TIRE_WIDTH_M + 0.022, rimRadius * 0.24);
  const spokeMesh = new THREE.Mesh(spokeGeo, spokeMat);
  wheelGroup.add(spokeMesh);

  return wheelGroup;
}

/**
 * Creates a procedural Three.js 4-wheel motorsport vehicle rig whose origin (`z = 0`)
 * coincides strictly with the tire contact patch plane (wheel centers at `z = tireRadiusM`).
 */
export function createProceduralVehicleRig(
  initialSpecs: ResolvedVehicleSpecs,
): VehicleRig {
  const root = new THREE.Group();
  root.name = 'vehicle_rig_root';

  const r = Math.max(0.15, initialSpecs.tireRadiusM || 0.316);
  const L = Math.max(1.5, initialSpecs.wheelbaseL || 2.65);
  const tf = Math.max(1.0, initialSpecs.trackF || 1.55);
  const tr = Math.max(1.0, initialSpecs.trackR || 1.55);
  const lr = L * initialSpecs.frontWeightRatio;
  const lf = L - lr;
  const cgZ = Math.max(r + 0.08, initialSpecs.cgHeight || 0.54);

  // Shared materials
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0x1e293b,
    metalness: 0.55,
    roughness: 0.32,
  });
  const accentMat = new THREE.MeshStandardMaterial({
    color: 0x38bdf8,
    metalness: 0.4,
    roughness: 0.25,
    emissive: 0x0369a1,
    emissiveIntensity: 0.35,
  });
  const glassMat = new THREE.MeshStandardMaterial({
    color: 0x0f172a,
    metalness: 0.85,
    roughness: 0.12,
    transparent: true,
    opacity: 0.86,
  });
  const headlightMat = new THREE.MeshBasicMaterial({ color: 0xe0f2fe });
  const taillightMat = new THREE.MeshBasicMaterial({ color: 0xf43f5e });
  const tireMat = new THREE.MeshStandardMaterial({
    color: 0x111827,
    roughness: 0.88,
    metalness: 0.05,
  });
  const rimMat = new THREE.MeshStandardMaterial({
    color: 0x94a3b8,
    metalness: 0.75,
    roughness: 0.25,
  });
  const spokeMat = new THREE.MeshBasicMaterial({ color: 0x38bdf8 });
  const fzArrowMat = new THREE.MeshBasicMaterial({
    color: 0x2f6fd6,
    transparent: true,
    opacity: 0.88,
  });

  // -------------------------------------------------------------------------
  // 1. Suspended Chassis Group (ISO 8855 Rz Ry Rx matching view3d.py)
  // -------------------------------------------------------------------------
  const chassis = new THREE.Group();
  chassis.name = 'chassis';
  chassis.rotation.order = 'ZYX';
  chassis.position.set(0, 0, cgZ);

  const bodyLen = lf + OVERHANG_FRONT_M + (lr + OVERHANG_REAR_M);
  const bodyCenterX = (lf + OVERHANG_FRONT_M - (lr + OVERHANG_REAR_M)) * 0.5;
  const bodyWidth = Math.max(tf, tr) + BODY_WIDTH_MARGIN_M;
  const bodyHeight = 0.44;
  const bodyBottomLocalZ = -(cgZ - r - 0.04);
  const bodyCenterLocalZ = bodyBottomLocalZ + bodyHeight * 0.5;

  const lowerBody = new THREE.Mesh(
    new THREE.BoxGeometry(bodyLen, bodyWidth, bodyHeight),
    bodyMat,
  );
  lowerBody.position.set(bodyCenterX, 0, bodyCenterLocalZ);
  chassis.add(lowerBody);

  // Motorsport side stripe / splitter accent
  const accentStrip = new THREE.Mesh(
    new THREE.BoxGeometry(bodyLen * 0.96, bodyWidth + 0.02, 0.055),
    accentMat,
  );
  accentStrip.position.set(bodyCenterX, 0, bodyBottomLocalZ + 0.05);
  chassis.add(accentStrip);

  // Cabin greenhouse
  const cabinLen = bodyLen * 0.52;
  const cabinWidth = bodyWidth * 0.82;
  const cabinHeight = 0.42;
  const cabin = new THREE.Mesh(
    new THREE.BoxGeometry(cabinLen, cabinWidth, cabinHeight),
    glassMat,
  );
  cabin.position.set(bodyCenterX - bodyLen * 0.06, 0, bodyCenterLocalZ + bodyHeight * 0.5 + cabinHeight * 0.46);
  chassis.add(cabin);

  // Front LED headlights (+X nose)
  const frontLightBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, bodyWidth * 0.78, 0.08),
    headlightMat,
  );
  frontLightBar.position.set(lf + OVERHANG_FRONT_M - 0.01, 0, bodyCenterLocalZ + 0.05);
  chassis.add(frontLightBar);

  // Rear LED tail-lights (-X tail)
  const rearLightBar = new THREE.Mesh(
    new THREE.BoxGeometry(0.05, bodyWidth * 0.8, 0.09),
    taillightMat,
  );
  rearLightBar.position.set(-(lr + OVERHANG_REAR_M) + 0.01, 0, bodyCenterLocalZ + 0.07);
  chassis.add(rearLightBar);

  root.add(chassis);

  // -------------------------------------------------------------------------
  // 2. Four Knuckles, Spinning Wheels & Optional Contact-Patch Force Vectors
  // -------------------------------------------------------------------------
  const forceVectorsGroup = new THREE.Group();
  forceVectorsGroup.name = 'force_vectors';
  forceVectorsGroup.visible = false;
  root.add(forceVectorsGroup);

  // Dynamic 3D acceleration arrows (longitudinal ax, lateral ay, combined net) above the roof
  const accelArrowLon = createHorizontalArrow('accel_arrow_lon', 0x10b981, 0.045, 0.11, 0.24);
  accelArrowLon.group.position.set(0, 0, cgZ + 0.72);
  const accelArrowLat = createHorizontalArrow('accel_arrow_lat', 0xf59e0b, 0.045, 0.11, 0.24);
  accelArrowLat.group.position.set(0, 0, cgZ + 0.72);
  const accelArrowNet = createHorizontalArrow('accel_arrow_net', 0xfb923c, 0.055, 0.13, 0.28);
  accelArrowNet.group.position.set(0, 0, cgZ + 0.76);
  forceVectorsGroup.add(accelArrowLon.group, accelArrowLat.group, accelArrowNet.group);

  const wheelCoords: Record<WheelId, [number, number]> = {
    FL: [lf, tf * 0.5],
    FR: [lf, -tf * 0.5],
    RL: [-lr, tr * 0.5],
    RR: [-lr, -tr * 0.5],
  };

  const fzBarGeo = new THREE.CylinderGeometry(0.048, 0.048, 1.0, 12);
  // Rotate cylinder from +Y axis to +Z vertical axis and shift base to z = 0
  fzBarGeo.rotateX(Math.PI / 2);
  fzBarGeo.translate(0, 0, 0.5);

  const fzConeGeo = new THREE.ConeGeometry(0.105, 0.22, 14);
  fzConeGeo.rotateX(Math.PI / 2);

  const gripDiscGeo = new THREE.CircleGeometry(r * 1.25, 28);

  const wheelNodes = {} as Record<WheelId, WheelNodes>;

  for (const id of ['FL', 'FR', 'RL', 'RR'] as const) {
    const [wx, wy] = wheelCoords[id];

    const knuckle = new THREE.Group();
    knuckle.name = `knuckle_${id}`;
    knuckle.position.set(wx, wy, r);

    const wheel = createWheelVisual(r, tireMat, rimMat, spokeMat);
    wheel.name = `wheel_${id}`;
    knuckle.add(wheel);
    root.add(knuckle);

    // Optional contact-patch force vector & grip disc at z = 0
    const lateralOutboard = wy >= 0 ? 0.28 : -0.28;
    const fzBar = new THREE.Mesh(fzBarGeo, fzArrowMat);
    fzBar.position.set(wx, wy + lateralOutboard, 0);
    forceVectorsGroup.add(fzBar);

    const fzCone = new THREE.Mesh(fzConeGeo, fzArrowMat);
    fzCone.position.set(wx, wy + lateralOutboard, 0.5);
    forceVectorsGroup.add(fzCone);

    const gripMat = new THREE.MeshBasicMaterial({
      color: 0x10b981,
      transparent: true,
      opacity: 0.58,
      depthWrite: false,
      side: THREE.DoubleSide,
    });
    const gripDisc = new THREE.Mesh(gripDiscGeo, gripMat);
    gripDisc.position.set(wx, wy, 0.035);
    forceVectorsGroup.add(gripDisc);

    wheelNodes[id] = { knuckle, wheel, fzBar, fzCone, gripDisc, gripMat };
  }

  let wheelSpinRad = 0;

  function updatePose(
    frame: SampleFrame,
    specs: ResolvedVehicleSpecs,
    opts?: VehicleRigUpdateOptions,
  ): void {
    const dtSec = opts?.dtSec ?? 0;
    const exaggerate = opts?.exaggerate ?? DEFAULT_EXAGGERATE;
    const radius = Math.max(0.15, specs.tireRadiusM || r);

    // 1. Integrate wheel spin: Δθ = (u / R) * dt
    if (Number.isFinite(dtSec) && dtSec > 0 && Number.isFinite(frame.speedMs)) {
      wheelSpinRad += (frame.speedMs / radius) * dtSec;
    }

    // 2. Articulate front steering knuckles (+steerRad = CCW left turn around +Z)
    wheelNodes.FL.knuckle.rotation.z = frame.steerRad;
    wheelNodes.FR.knuckle.rotation.z = frame.steerRad;

    // 3. Spin all 4 wheels around their +Y axle
    wheelNodes.FL.wheel.rotation.y = wheelSpinRad;
    wheelNodes.FR.wheel.rotation.y = wheelSpinRad;
    wheelNodes.RL.wheel.rotation.y = wheelSpinRad;
    wheelNodes.RR.wheel.rotation.y = wheelSpinRad;

    // 4. Suspended chassis roll & pitch (ISO 8855 Rz Ry Rx matching view3d.py)
    // +rollRad = right side down (around +X); +pitchRad = nose down (around +Y)
    chassis.rotation.x = frame.rollRad * exaggerate;
    chassis.rotation.y = frame.pitchRad * exaggerate;
    chassis.rotation.z = 0;

    // 5. Optional 3D contact-patch force vectors, grip discs & dynamic acceleration arrows
    const showForces = Boolean(opts?.showForceVectors);
    forceVectorsGroup.visible = showForces;
    if (showForces) {
      const refLoadN = Math.max(1, specs.grossMassKg * GRAVITY_MS2 * 0.45);
      const loads: Record<WheelId, number> = {
        FL: frame.fzFL,
        FR: frame.fzFR,
        RL: frame.fzRL,
        RR: frame.fzRR,
      };
      const kammUtil = Math.max(0, Math.min(1, frame.kammIndex / 1.15));

      for (const id of ['FL', 'FR', 'RL', 'RR'] as const) {
        const node = wheelNodes[id];
        const fz = Math.max(0, loads[id]);
        const arrowLen = Math.max(0.08, Math.min(FORCE_ARROW_MAX_M, (fz / refLoadN) * 0.95));
        node.fzBar.scale.set(1, 1, arrowLen);
        node.fzCone.position.z = arrowLen + 0.11;

        const discScale = Math.max(0.35, Math.min(1.55, Math.sqrt(fz / refLoadN)));
        node.gripDisc.scale.set(discScale, discScale, 1);
        node.gripMat.color.set(colorForUtilization(kammUtil));
      }

      const axG = Number.isFinite(frame.ax) ? frame.ax / GRAVITY_MS2 : 0;
      const ayG = Number.isFinite(frame.ay) ? frame.ay / GRAVITY_MS2 : 0;
      const netG = Math.hypot(axG, ayG);

      // Longitudinal acceleration (+X green) / braking (-X crimson)
      if (Math.abs(axG) < ACCEL_DEADZONE_G) {
        accelArrowLon.group.visible = false;
      } else {
        const len = Math.min(ACCEL_ARROW_MAX_M, Math.abs(axG) * ACCEL_SCALE_M_PER_G);
        accelArrowLon.group.visible = true;
        accelArrowLon.group.rotation.z = axG > 0 ? 0 : Math.PI;
        accelArrowLon.material.color.set(axG > 0 ? 0x10b981 : 0xf43f5e);
        accelArrowLon.shaft.scale.set(len, 1, 1);
        accelArrowLon.cone.position.x = len + accelArrowLon.coneHeight * 0.5;
      }

      // Lateral acceleration (+Y left / -Y right in ISO 8855)
      if (Math.abs(ayG) < ACCEL_DEADZONE_G) {
        accelArrowLat.group.visible = false;
      } else {
        const len = Math.min(ACCEL_ARROW_MAX_M, Math.abs(ayG) * ACCEL_SCALE_M_PER_G);
        accelArrowLat.group.visible = true;
        accelArrowLat.group.rotation.z = ayG > 0 ? Math.PI / 2 : -Math.PI / 2;
        accelArrowLat.shaft.scale.set(len, 1, 1);
        accelArrowLat.cone.position.x = len + accelArrowLat.coneHeight * 0.5;
      }

      // Combined horizontal acceleration resultant (ax, ay)
      if (netG < ACCEL_NET_DEADZONE_G) {
        accelArrowNet.group.visible = false;
      } else {
        const len = Math.min(ACCEL_NET_ARROW_MAX_M, netG * ACCEL_SCALE_M_PER_G);
        accelArrowNet.group.visible = true;
        accelArrowNet.group.rotation.z = Math.atan2(ayG, axG);
        accelArrowNet.shaft.scale.set(len, 1, 1);
        accelArrowNet.cone.position.x = len + accelArrowNet.coneHeight * 0.5;
      }
    } else {
      accelArrowLon.group.visible = false;
      accelArrowLat.group.visible = false;
      accelArrowNet.group.visible = false;
    }
  }

  function dispose(): void {
    const geometries = new Set<THREE.BufferGeometry>();
    const materials = new Set<THREE.Material>();

    root.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        geometries.add(obj.geometry);
        if (Array.isArray(obj.material)) {
          for (const m of obj.material) materials.add(m);
        } else {
          materials.add(obj.material);
        }
      }
    });

    for (const g of geometries) g.dispose();
    for (const m of materials) m.dispose();
  }

  return {
    getObject3D: () => root,
    updatePose,
    getWheelSpinRad: () => wheelSpinRad,
    dispose,
  };
}
