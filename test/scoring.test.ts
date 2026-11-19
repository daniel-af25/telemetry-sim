/**
 * Issue #23 — Fase 1.5e: Incidentes (7 Categorias), Slip ISO & 5 Pilares (src/core/scoring.ts)
 * Destino em telemetry-sim: test/scoring.test.ts
 *
 * Contrato travado por este teste:
 *   - evaluateIncidentSlip(ayIsoMs2, speedMs, omegaZRadS): { isSlip: boolean; slipResidualG: number }
 *   - selectDebouncedIncident<T extends IncidentCandidate>(events: readonly T[]): T
 *   - detectIncidents(samples: readonly CalibratedSampleIso[], limits: KammLimits): Incident[]
 *   - computeDrivingSkillPillars(
 *       samples: readonly CalibratedSampleIso[],
 *       incidents: readonly Incident[],
 *       effectiveDistanceKm: number
 *     ): DrivingSkillPillar[]
 *   - hasSufficientTelemetry(sampleCount: number, movingDurationSec: number): boolean
 *       Regra aprovada: sampleCount >= 1500 (5 min a 5 Hz) E movingDurationSec >= 120 s.
 */
import { describe, expect, it } from 'vitest';
import {
  computeDrivingSkillPillars,
  detectIncidents,
  evaluateIncidentSlip,
  hasSufficientTelemetry,
  selectDebouncedIncident,
  type IncidentCandidate,
} from '../src/core/scoring.ts';
import type { CalibratedSampleIso, KammLimits } from '../src/core/types.ts';

const G = 9.80665;
const LIMITS: KammLimits = {
  accelLimit: 0.45,
  brakeLimit: 0.55,
  latLimit: 0.5,
  gripLimitG: 0.95,
};

function isoSample(
  i: number,
  overrides: Partial<CalibratedSampleIso> = {},
): CalibratedSampleIso {
  return {
    sampleIndex: i,
    timestamp: i * 0.2,
    timestampMs: 1794936091800 + i * 200,
    elapsedSec: i * 0.2,
    dtSec: 0.2,
    isGap: false,
    lat: 41.17 + i * 0.00005,
    lon: -8.55,
    gpsValid: true,
    speedMs: 15.0, // 54 km/h
    ax: 0,
    ay: 0,
    az: G,
    omegaX: 0,
    omegaY: 0,
    omegaZ: 0,
    roadGradePct: 0,
    ...overrides,
  };
}

describe('scoring — evaluateIncidentSlip (sinal ISO 8855 preservado)', () => {
  it('deteta contra-brecagem real (+ay com -omegaZ)', () => {
    // ay = +4.0 m/s² (+0.408 G), u*wz = 15 * (-0.4) = -6.0 m/s² (-0.612 G) => residual ≈ 1.02 G > 0.35 G
    const res = evaluateIncidentSlip(4.0, 15.0, -0.4);
    expect(res.isSlip).toBe(true);
    expect(res.slipResidualG).toBeGreaterThan(0.95);
  });

  it('NÃO gera falso positivo em ruído baixo ou abaixo de 25 km/h (6.94 m/s)', () => {
    // Pequeno ruído de sinais opostos: residual = |0.5 - 15*(-0.02)| / g = 0.08 G < 0.35 G
    expect(evaluateIncidentSlip(0.5, 15.0, -0.02).isSlip).toBe(false);
    // Velocidade baixa (< 25 km/h) nunca dispara slip
    expect(evaluateIncidentSlip(5.0, 5.0, -0.5).isSlip).toBe(false);
    // Curva normal coerente: ay = u * omegaZ
    expect(evaluateIncidentSlip(4.5, 15.0, 0.3).isSlip).toBe(false);
  });
});

describe('scoring — selectDebouncedIncident & detectIncidents (7 categorias + gap closure)', () => {
  it('desempata por points e depois por excessRatio', () => {
    const events: IncidentCandidate[] = [
      { category: 'combined_brake', points: 2, excessRatio: 1.4 },
      { category: 'braking', points: 7, excessRatio: 1.1 },
    ];
    expect(selectDebouncedIncident(events).category).toBe('braking');

    const tied: IncidentCandidate[] = [
      { category: 'lateral', points: 4, excessRatio: 0.2 },
      { category: 'braking', points: 4, excessRatio: 0.32 },
    ];
    expect(selectDebouncedIncident(tied).category).toBe('braking');
  });

  it('classifica todas as 7 categorias (braking, acceleration, lateral, combined_brake, combined_traction, bump, slip)', () => {
    // Separamos cada evento por 2.0 s (> cooldown 1.0 s) para gerar 7 clusters distintos
    const samples: CalibratedSampleIso[] = [];
    const pushQuiet = (count: number) => {
      for (let k = 0; k < count; k++) samples.push(isoSample(samples.length));
    };

    // 1. Pure braking (-0.75 G > 0.55)
    samples.push(isoSample(samples.length, { ax: -0.75 * G }));
    pushQuiet(8);
    // 2. Pure acceleration (+0.65 G > 0.45)
    samples.push(isoSample(samples.length, { ax: 0.65 * G }));
    pushQuiet(8);
    // 3. Pure lateral (+0.70 G > 0.50; omegaZ coerente para não ser slip)
    samples.push(isoSample(samples.length, { ay: 0.7 * G, omegaZ: (0.7 * G) / 15 }));
    pushQuiet(8);
    // 4. Combined brake (normLon=0.8, normLat=0.8 => kamm=1.13)
    samples.push(
      isoSample(samples.length, {
        ax: -0.44 * G,
        ay: 0.4 * G,
        omegaZ: (0.4 * G) / 15,
      }),
    );
    pushQuiet(8);
    // 5. Combined traction (normLon=0.8, normLat=0.8 => kamm=1.13)
    samples.push(
      isoSample(samples.length, {
        ax: 0.36 * G,
        ay: -0.4 * G,
        omegaZ: (-0.4 * G) / 15,
      }),
    );
    pushQuiet(8);
    // 6. Bump (|az/g - 1| = 1.0 > 0.80, |gyroY| = 25 °/s > 18, speed = 54 > 35 km/h)
    samples.push(
      isoSample(samples.length, {
        az: 2.0 * G,
        omegaY: (25 * Math.PI) / 180,
      }),
    );
    pushQuiet(8);
    // 7. Slip puro (dentro do Kamm mas contra-brecagem severa)
    samples.push(
      isoSample(samples.length, {
        ay: 0.3 * G,
        omegaZ: -0.35, // u*wz = -5.25 m/s² => residual ≈ 0.84 G > 0.35 G
      }),
    );

    const incidents = detectIncidents(samples, LIMITS);
    const categories = new Set(incidents.map((inc) => inc.category));

    expect(categories).toEqual(
      new Set([
        'braking',
        'acceleration',
        'lateral',
        'combined_brake',
        'combined_traction',
        'bump',
        'slip',
      ]),
    );
  });

  it('fecha cluster aberto quando ocorre uma lacuna isGap=true (dt > 1.0 s)', () => {
    const samples: CalibratedSampleIso[] = [
      isoSample(0, { ax: -0.7 * G }),
      isoSample(1, { ax: -0.72 * G, isGap: true }), // lacuna fecha cluster 0 e abre cluster 1
    ];

    const incidents = detectIncidents(samples, LIMITS);
    expect(incidents).toHaveLength(2);
  });
});

describe('scoring — 5 Pilares & Regra de Suficiência (>= 1500 amostras E >= 120 s)', () => {
  it('calcula os 5 Pilares sem dupla contagem e ignora jerk através de lacunas isGap', () => {
    const samples: CalibratedSampleIso[] = [
      isoSample(0, { ax: 0.0, isGap: false }),
      isoSample(1, { ax: 0.5 * G, isGap: true }), // Δax/dt = 2.5 G/s mas é isGap => NÃO deve contar harshShift!
      isoSample(2, { ax: 0.5 * G, isGap: false }),
    ];

    const incidents = [
      {
        category: 'braking' as const,
        points: 4,
        excessRatio: 0.25,
        elapsedSec: 10,
        timeStr: '+00:10',
        timestamp: 10,
        lat: 41.17,
        lon: -8.55,
        reason: 'Harsh Braking Shock',
        intensity: '0.70 G',
      },
    ];

    const pillars = computeDrivingSkillPillars(samples, incidents, 10.0);
    expect(pillars).toHaveLength(5);

    const byName = Object.fromEntries(pillars.map((p) => [p.name, p]));
    // Apenas BRAKING DISCIPLINE sofre dedução (100 - 4*2.5*1.0 = 90)
    expect(byName['BRAKING DISCIPLINE']?.score).toBe(90);
    expect(byName['CORNERING STABILITY']?.score).toBe(100);
    expect(byName['TRACTION CONTROL']?.score).toBe(100);
    expect(byName['CHASSIS CARE']?.score).toBe(100);
    // Powertrain não foi penalizado pelo salto na lacuna isGap
    expect(byName['POWERTRAIN SYMPATHY']?.score).toBe(100);
  });

  it('impõe regra aprovada de suficiência: >= 1500 amostras E >= 120 s em movimento', () => {
    expect(hasSufficientTelemetry(1500, 120)).toBe(true);
    expect(hasSufficientTelemetry(1499, 120)).toBe(false);
    expect(hasSufficientTelemetry(2000, 119.9)).toBe(false);
    expect(hasSufficientTelemetry(0, 0)).toBe(false);
  });
});
