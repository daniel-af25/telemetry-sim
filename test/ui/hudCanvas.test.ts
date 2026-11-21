/**
 * Testes unitários dos helpers puros de `src/ui/hudCanvas.ts`:
 * - Clamp visual à borda no Diagrama G-G (`clampPointToCircle`).
 * - Utilização de atrito por roda e deteção de levantamento (`Fz == 0`).
 * - Sanitização XSS rigorosa de metadados CSV (`formatSanitizedSessionMetadata`).
 */
import { describe, expect, it } from 'vitest';
import {
  clampPointToCircle,
  computeWheelFrictionUtilization,
  formatSanitizedSessionMetadata,
} from '../../src/ui/hudCanvas.ts';

describe('hudCanvas — G-G clamp, Fz wheel lift & sanitização XSS', () => {
  it('mantém pontos dentro da escala e aplica clamp radial à borda para picos extremos', () => {
    const inside = clampPointToCircle(0.3, -0.4, 1.2);
    expect(inside.clamped).toBe(false);
    expect(inside.x).toBeCloseTo(0.3, 6);
    expect(inside.y).toBeCloseTo(-0.4, 6);

    const extreme = clampPointToCircle(3.0, 4.0, 1.2);
    expect(extreme.clamped).toBe(true);
    expect(Math.hypot(extreme.x, extreme.y)).toBeCloseTo(1.2, 5);
    expect(extreme.x / extreme.y).toBeCloseTo(3 / 4, 5);
  });

  it('deteta levantamento de roda (Fz == 0) e calcula utilização de atrito em piso molhado/seco', () => {
    const lifted = computeWheelFrictionUtilization(0, 0, 5.0, 0.95);
    expect(lifted.isLifted).toBe(true);
    expect(lifted.ratio).toBe(0);

    const loaded = computeWheelFrictionUtilization(4200, 0, 0.55 * 9.80665, 0.55);
    expect(loaded.isLifted).toBe(false);
    expect(loaded.ratio).toBeCloseTo(1.0, 4);
  });

  it('sanitiza payloads XSS em driver, vehicle, sessionId e metadados # key=value', () => {
    const sanitized = formatSanitizedSessionMetadata({
      sessionId: 'TRIP_<script>alert(1)</script>',
      driverName: `<img src=x onerror='xss'>`,
      vehicleName: 'Audi & "RS3"',
      metadata: {
        track: '<b>Braga</b>',
      },
    });

    expect(sanitized).not.toContain('<script>');
    expect(sanitized).not.toContain('<img');
    expect(sanitized).not.toContain('<b>');
    expect(sanitized).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(sanitized).toContain('Audi &amp; &quot;RS3&quot;');
  });
});
