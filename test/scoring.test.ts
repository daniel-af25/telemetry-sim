import { test } from 'node:test';
import assert from 'node:assert';
import { evaluateIncidentSlip, selectDebouncedIncident } from '../src/core/scoring.ts';

test('Scoring: Deteção de derrapagem isSlip preservando sinal ISO', () => {
  // Carro em apoio à esquerda (+ay) com volante em contra-brecagem (-omega_z)
  const isSlip = evaluateIncidentSlip(4.0, 15.0, -0.4);
  assert.strictEqual(isSlip, true, 'Contra-brecagem tem de disparar isSlip');
});

test('Scoring: Seleção do pior evento por points e desempate por excessRatio', () => {
  const events = [
    { category: 'combined_brake', points: 2, excessRatio: 1.4 },
    { category: 'braking', points: 7, excessRatio: 1.1 }, // Travagem severa tem prioridade
  ] as any;
  const worst = selectDebouncedIncident(events);
  assert.strictEqual(worst.category, 'braking');
});