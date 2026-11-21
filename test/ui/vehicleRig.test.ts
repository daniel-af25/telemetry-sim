/**
 * Issue #14 — Fase 4.2: ProceduralVehicleRig (z = 0) & Guarda DEM de threeLayer.ts
 * Destino em telemetry-sim: test/ui/vehicleRig.test.ts
 *
 * Contrato travado por este teste (corre em Vitest/Node puro, SEM precisar de WebGL):
 *   Em `src/ui/vehicleRig.ts`:
 *     - createProceduralVehicleRig(specs: ResolvedVehicleSpecs): VehicleRig
 *         VehicleRig = {
 *           getObject3D(): THREE.Group; // nós nomeados: 'chassis', 'knuckle_FL', 'knuckle_FR', 'wheel_FL', 'wheel_FR', 'wheel_RL', 'wheel_RR'
 *           updatePose(frame: SampleFrame, specs: ResolvedVehicleSpecs, opts?: { dtSec?: number; exaggerate?: number; showForceVectors?: boolean }): void;
 *           getWheelSpinRad(): number;
 *           dispose(): void;
 *         }
 *   Em `src/ui/threeLayer.ts`:
 *     - resolveTerrainElevation(queried: number | null | undefined, lastValid?: number): number
 *
 * Invariantes físicos 3D travados (ISO 8855, idênticos a view3d.py):
 *   - Origem do rig (z = 0) coincide exatamente com a base da banda de rodagem dos 4 pneus
 *     (centro de cada roda em z == tireRadiusM).
 *   - Distância longitudinal entre eixos == wheelbaseL; via dianteira == trackF; traseira == trackR.
 *   - steerRad > 0 (curva à esquerda) => knuckle_FL/FR.rotation.z == +steerRad (CCW em +Z).
 *   - rollRad > 0 (+ lado direito para baixo) => chassis.rotation.x == +rollRad * exaggerate.
 *   - pitchRad > 0 (+ nariz para baixo) => chassis.rotation.y == +pitchRad * exaggerate.
 *   - Rotação de rodas integra Δθ = (speedMs / tireRadiusM) * dtSec.
 */
import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import type { SampleFrame } from '../../src/core/interpolator.ts';
import type { ResolvedVehicleSpecs } from '../../src/core/vehicleSpecs.ts';
import {
  computeTerrainPlanePose,
  resolveTerrainElevation,
  shouldReleaseChaseOnInteraction,
} from '../../src/ui/threeLayer.ts';
import { createProceduralVehicleRig } from '../../src/ui/vehicleRig.ts';

const SPECS: ResolvedVehicleSpecs = {
  id: 1,
  name: 'Test Car 3D',
  curbMassKg: 1400,
  payloadKg: 100,
  grossMassKg: 1500,
  powerHp: 180,
  wheelbaseL: 2.65,
  trackF: 1.56,
  trackR: 1.54,
  cgHeight: 0.54,
  frontWeightRatio: 0.58,
  frontRollShare: 0.58,
  maxSteerRad: 0.6109,
  tireSize: '205/55 R16',
  tireRadiusM: 0.316,
  surfaceGrip: 0.95,
  geometrySource: 'estimated',
};

function makeFrame(overrides: Partial<SampleFrame> = {}): SampleFrame {
  return {
    t: 0,
    lat: 41.172,
    lon: -8.5485,
    x: 0,
    y: 0,
    speedMs: 0,
    ax: 0,
    ay: 0,
    az: 9.80665,
    omegaZ: 0,
    yaw: 0,
    steerRad: 0,
    rollRad: 0,
    pitchRad: 0,
    fzFL: 4266,
    fzFR: 4266,
    fzRL: 3089,
    fzRR: 3089,
    kammIndex: 0,
    roadGradePct: 0,
    distM: 0,
    gpsValid: true,
    isGap: false,
    isTunnelDr: false,
    isSlip: false,
    ...overrides,
  };
}

describe('vehicleRig — assentamento z=0, dimensões reais e sinais ISO 8855', () => {
  it('ancora a banda de rodagem exatamente em z = 0 (centros das 4 rodas em z == tireRadiusM) com wheelbase e track exatos', () => {
    const rig = createProceduralVehicleRig(SPECS);
    const root = rig.getObject3D();
    rig.updatePose(makeFrame(), SPECS, { dtSec: 0, exaggerate: 4 });
    root.updateMatrixWorld(true);

    const posOf = (name: string): THREE.Vector3 => {
      const node = root.getObjectByName(name);
      expect(node, `Nó 3D "${name}" em falta no VehicleRig`).toBeDefined();
      const v = new THREE.Vector3();
      node!.getWorldPosition(v);
      return v;
    };

    const fl = posOf('wheel_FL');
    const fr = posOf('wheel_FR');
    const rl = posOf('wheel_RL');
    const rr = posOf('wheel_RR');

    // Centro de cada roda em z == tireRadiusM => base do pneu em z == 0 (não enterra nem flutua!)
    for (const p of [fl, fr, rl, rr]) {
      expect(p.z).toBeCloseTo(SPECS.tireRadiusM, 4);
    }

    // Dimensões físicas reais ISO 8855 (+X frente, +Y esquerda)
    expect(fl.x - rl.x).toBeCloseTo(SPECS.wheelbaseL, 3);
    expect(fl.y - fr.y).toBeCloseTo(SPECS.trackF, 3);
    expect(rl.y - rr.y).toBeCloseTo(SPECS.trackR, 3);
    expect(fl.y).toBeGreaterThan(0); // esquerda = +Y
    expect(fr.y).toBeLessThan(0); // direita = -Y

    rig.dispose();
  });

  it('articula direção (+steerRad -> esquerda), suspensão 4x (roll/pitch ISO) e rotação das rodas (u / R)', () => {
    const rig = createProceduralVehicleRig(SPECS);
    const root = rig.getObject3D();

    const frame = makeFrame({
      speedMs: 10.0,
      steerRad: 0.25, // curva à esquerda (+Z CCW)
      rollRad: 0.04, // + lado direito para baixo
      pitchRad: 0.03, // + nariz para baixo (travagem)
    });

    rig.updatePose(frame, SPECS, { dtSec: 0.5, exaggerate: 4.0 });

    const knuckleFL = root.getObjectByName('knuckle_FL');
    const knuckleFR = root.getObjectByName('knuckle_FR');
    const chassis = root.getObjectByName('chassis');

    expect(knuckleFL?.rotation.z).toBeCloseTo(0.25, 4);
    expect(knuckleFR?.rotation.z).toBeCloseTo(0.25, 4);
    expect(chassis?.rotation.x).toBeCloseTo(0.04 * 4.0, 4);
    expect(chassis?.rotation.y).toBeCloseTo(0.03 * 4.0, 4);

    // Rotação acumulada da roda: (10.0 / 0.316) * 0.5 ≈ 15.8228 rad
    const expectedSpin = (10.0 / SPECS.tireRadiusM) * 0.5;
    expect(rig.getWheelSpinRad()).toBeCloseTo(expectedSpin, 2);

    // A velocidade 0, a roda não roda mais
    rig.updatePose(makeFrame({ speedMs: 0 }), SPECS, { dtSec: 1.0, exaggerate: 4.0 });
    expect(rig.getWheelSpinRad()).toBeCloseTo(expectedSpin, 2);

    rig.dispose();
  });
});

describe('threeLayer — resolveTerrainElevation (guarda null/offline do DEM)', () => {
  it('devolve a elevação medida quando finita e faz fallback seguro para lastValid/0 quando null ou NaN', () => {
    expect(resolveTerrainElevation(84.5, 10)).toBeCloseTo(84.5, 4);
    expect(resolveTerrainElevation(null, 84.5)).toBeCloseTo(84.5, 4);
    expect(resolveTerrainElevation(undefined, 42.0)).toBeCloseTo(42.0, 4);
    expect(resolveTerrainElevation(Number.NaN, 42.0)).toBeCloseTo(42.0, 4);
    expect(resolveTerrainElevation(null)).toBe(0);
  });
});

describe('threeLayer — guarda Chase & alinhamento ao terreno DEM nas 4 rodas', () => {
  it('ignora eventos programáticos (originalEvent ausente) e só liberta Chase com interação real do utilizador', () => {
    expect(shouldReleaseChaseOnInteraction('chase', undefined)).toBe(false);
    expect(shouldReleaseChaseOnInteraction('chase', { originalEvent: undefined })).toBe(false);
    expect(shouldReleaseChaseOnInteraction('chase', { originalEvent: {} })).toBe(true);
    expect(shouldReleaseChaseOnInteraction('topdown', { originalEvent: {} })).toBe(false);
    expect(shouldReleaseChaseOnInteraction('free', { originalEvent: {} })).toBe(false);
  });

  it('alinha pitch/roll ao declive DEM e mantém todas as 4 rodas acima do terreno (sem afundar)', () => {
    // 1. Terreno plano
    const flat = computeTerrainPlanePose(
      100,
      { fl: 100, fr: 100, rl: 100, rr: 100 },
      SPECS,
    );
    expect(flat.terrainPitchRad).toBeCloseTo(0, 6);
    expect(flat.terrainRollRad).toBeCloseTo(0, 6);
    expect(flat.elevation).toBeGreaterThan(100);

    // 2. Inclinação transversal com lado direito (+40 cm) mais alto que o esquerdo
    const rightUp = computeTerrainPlanePose(
      100.2,
      { fl: 100.0, rl: 100.0, fr: 100.4, rr: 100.4 },
      SPECS,
    );
    expect(rightUp.terrainRollRad).toBeLessThan(0);

    const lr = SPECS.wheelbaseL * SPECS.frontWeightRatio;
    const lf = SPECS.wheelbaseL - lr;
    const sinP = Math.sin(rightUp.terrainPitchRad);
    const cosP = Math.cos(rightUp.terrainPitchRad);
    const sinR = Math.sin(rightUp.terrainRollRad);

    const zFL = rightUp.elevation + (-lf * sinP + SPECS.trackF * 0.5 * sinR * cosP);
    const zFR = rightUp.elevation + (-lf * sinP - SPECS.trackF * 0.5 * sinR * cosP);
    const zRL = rightUp.elevation + (lr * sinP + SPECS.trackR * 0.5 * sinR * cosP);
    const zRR = rightUp.elevation + (lr * sinP - SPECS.trackR * 0.5 * sinR * cosP);

    expect(zFL).toBeGreaterThanOrEqual(100.0);
    expect(zFR).toBeGreaterThanOrEqual(100.4);
    expect(zRL).toBeGreaterThanOrEqual(100.0);
    expect(zRR).toBeGreaterThanOrEqual(100.4);

    // 3. Subida longitudinal (+50 cm na frente) => pitch negativo (nariz para cima)
    const uphill = computeTerrainPlanePose(
      100.25,
      { fl: 100.5, fr: 100.5, rl: 100.0, rr: 100.0 },
      SPECS,
    );
    expect(uphill.terrainPitchRad).toBeLessThan(0);
  });
});
