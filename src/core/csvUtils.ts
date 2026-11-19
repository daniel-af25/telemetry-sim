/**
 * Utilitários RFC 4180 para parsing e serialização segura de linhas CSV.
 * Reutilizado em `parser.ts`, `vehicleCatalog.ts` e futuramente `schema6Export.ts`.
 *
 * Testes relacionados:
 *   npx vitest run test/parser.test.ts test/vehicleCatalog.test.ts
 */
/**
 * Splits a single CSV line into fields using `delimiter`, respecting
 * double-quoted fields (`"..."`) and escaped double quotes (`""`).
 */
export function splitCsvLine(line: string, delimiter: string = ','): string[] {
  const cells: string[] = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === delimiter && !inQuotes) {
      cells.push(current);
      current = '';
    } else if (ch !== undefined) {
      current += ch;
    }
  }

  cells.push(current);
  return cells;
}

/**
 * Escapes a value for safe CSV serialization (RFC 4180). Wraps the field in
 * double quotes and doubles internal quotes whenever it contains the delimiter,
 * a quote, or a newline character.
 */
export function escapeCsvField(
  value: string | number | boolean | null | undefined,
  delimiter: string = ',',
): string {
  if (value === null || value === undefined) {
    return '';
  }

  const str = String(value);
  const needsQuotes =
    str.includes(delimiter) ||
    str.includes('"') ||
    str.includes('\n') ||
    str.includes('\r');

  if (!needsQuotes) {
    return str;
  }

  return `"${str.replaceAll('"', '""')}"`;
}
