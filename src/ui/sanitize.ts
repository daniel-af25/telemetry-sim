/**
 * Utilitário de sanitização HTML para proteção contra XSS em strings vindas de CSV,
 * catálogo de veículos ou metadados de sessão (`# key=value`).
 *
 * Testes:
 *   npx vitest run test/ui/sanitize.test.ts
 */

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes HTML special characters (`&`, `<`, `>`, `"`, `'`) to prevent XSS.
 * Returns an empty string for `null` or `undefined`.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/[&<>"']/g, (ch) => HTML_ESCAPE_MAP[ch] ?? ch);
}
