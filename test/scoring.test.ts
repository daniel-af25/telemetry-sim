import { describe, expect, it } from 'vitest';
import {
  evaluateIncidentSlip,
  selectDebouncedIncident,
  type IncidentCandidate,
} from '../src/core/scoring.ts';

describe('scoring', () => {
  it('Scoring: Deteção de derrapagem isSlip preservando sinal ISO', () => {
    // Carro em apoio à esquerda (+ay) com volante em contra-brecagem (-omega_z)
    const isSlip = evaluateIncidentSlip(4.0, 15.0, -0.4);
    expect(isSlip).toBe(true);
  });

  it('Scoring: Seleção do pior evento por points e desempate por excessRatio', () => {
    const events: IncidentCandidate[] = [
      { category: 'combined_brake', points: 2, excessRatio: 1.4 },
      { category: 'braking', points: 7, excessRatio: 1.1 }, // Travagem severa tem prioridade
    ];
    const worst = selectDebouncedIncident(events);
    expect(worst.category).toBe('braking');
  });
});
