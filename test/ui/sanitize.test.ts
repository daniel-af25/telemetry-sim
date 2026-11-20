/**
 * Issue #16 — Fase 5.2: Sanitização XSS (src/ui/sanitize.ts)
 * Destino em telemetry-sim: test/ui/sanitize.test.ts
 *
 * Contrato travado por este teste:
 *   - escapeHtml(value: unknown): string
 *       Escapa &, <, >, ", ' e trata null/undefined como ''.
 */
import { describe, expect, it } from 'vitest';
import { escapeHtml } from '../../src/ui/sanitize.ts';

describe('sanitize — escapeHtml (proteção XSS para metadados CSV)', () => {
  it('neutraliza payloads XSS em nomes de veículos, condutores ou cabeçalhos # key=value', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert(&quot;xss&quot;)&lt;/script&gt;',
    );
    expect(escapeHtml(`<img src=x onerror='alert(1)'>`)).toBe(
      '&lt;img src=x onerror=&#39;alert(1)&#39;&gt;',
    );
    expect(escapeHtml('A & B')).toBe('A &amp; B');
  });

  it('lida de forma segura com null, undefined, números e strings normais', () => {
    expect(escapeHtml(null)).toBe('');
    expect(escapeHtml(undefined)).toBe('');
    expect(escapeHtml(204)).toBe('204');
    expect(escapeHtml('AUDI A3 Sportback 40 TFSI e')).toBe('AUDI A3 Sportback 40 TFSI e');
  });
});
