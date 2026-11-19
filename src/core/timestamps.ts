/**
 * Motor temporal: converte timestamps heterogéneos (epoch ms, epoch s, ISO-8601,
 * segundos relativos) para milissegundos e calcula `elapsedSec`, `dtSec` e lacunas `isGap` (> 1.0 s).
 *
 * Testes:
 *   npx vitest run test/timestamps.test.ts
 */
export const DEFAULT_DT_SEC = 0.2;
export const DEFAULT_GAP_THRESHOLD_SEC = 1.0;

const EPOCH_MS_THRESHOLD = 1e12;
const ISO_8601_PATTERN = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

export interface SampleTiming {
  elapsedSec: number;
  dtSec: number;
  isGap: boolean;
}

/**
 * Parses a raw timestamp into milliseconds, supporting:
 * - (a) Unix epoch milliseconds (`>= 1e12`) or epoch seconds (`10` digits → `* 1000`)
 * - (b) ISO-8601 strings (`YYYY-MM-DD HH:MM:SS.sss` or with `T`)
 * - (c) Relative numeric seconds (`0.0`, `0.2`, `0.4` → `* 1000`)
 *
 * Returns `NaN` for empty, nullish, invalid, or legacy non-ISO formats.
 */
export function parseTimestampMs(ts: string | number | null | undefined): number {
  if (ts === null || ts === undefined) {
    return Number.NaN;
  }

  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return Number.NaN;
    return Math.abs(ts) >= EPOCH_MS_THRESHOLD ? ts : ts * 1000;
  }

  const trimmed = ts.trim();
  if (trimmed === '') {
    return Number.NaN;
  }

  const asNum = Number(trimmed);
  if (Number.isFinite(asNum)) {
    return Math.abs(asNum) >= EPOCH_MS_THRESHOLD ? asNum : asNum * 1000;
  }

  if (ISO_8601_PATTERN.test(trimmed)) {
    const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    const ms = Date.parse(normalized);
    return Number.isFinite(ms) ? ms : Number.NaN;
  }

  return Number.NaN;
}

/**
 * Computes `{ elapsedSec, dtSec, isGap }` for each sample in `timestampsMs`.
 * Gaps with `rawDt > 1.0 s` set `isGap = true` and fall back to `defaultDtSec`
 * (`0.20 s`) for `dtSec` while preserving true `elapsedSec`.
 */
export function computeSampleTiming(
  timestampsMs: readonly number[],
  defaultDtSec: number = DEFAULT_DT_SEC,
): SampleTiming[] {
  const result: SampleTiming[] = [];
  if (timestampsMs.length === 0) {
    return result;
  }

  const firstMs = timestampsMs[0];
  let startMs = firstMs !== undefined && Number.isFinite(firstMs) ? firstMs : Number.NaN;
  let prevMs = startMs;
  let prevElapsedSec = 0;

  result.push({
    elapsedSec: 0,
    dtSec: defaultDtSec,
    isGap: false,
  });

  for (let i = 1; i < timestampsMs.length; i++) {
    const currMs = timestampsMs[i];
    const hasCurr = currMs !== undefined && Number.isFinite(currMs);

    if (!hasCurr) {
      const elapsedSec = prevElapsedSec + defaultDtSec;
      result.push({
        elapsedSec,
        dtSec: defaultDtSec,
        isGap: false,
      });
      prevElapsedSec = elapsedSec;
      continue;
    }

    if (!Number.isFinite(startMs) || !Number.isFinite(prevMs)) {
      startMs = currMs - (prevElapsedSec + defaultDtSec) * 1000;
      prevMs = currMs;
      const elapsedSec = prevElapsedSec + defaultDtSec;
      result.push({
        elapsedSec,
        dtSec: defaultDtSec,
        isGap: false,
      });
      prevElapsedSec = elapsedSec;
      continue;
    }

    const rawDt = (currMs - prevMs) / 1000;
    const isGap = rawDt > DEFAULT_GAP_THRESHOLD_SEC;
    const dtSec = isGap || rawDt <= 0 ? defaultDtSec : rawDt;
    const elapsedSec = (currMs - startMs) / 1000;

    result.push({
      elapsedSec,
      dtSec,
      isGap,
    });

    prevMs = currMs;
    prevElapsedSec = elapsedSec;
  }

  return result;
}
