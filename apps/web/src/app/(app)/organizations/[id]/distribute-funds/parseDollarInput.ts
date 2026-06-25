import { toMicrodollars } from '@/lib/utils';

export type ParsedDollarInput = { microdollars: number; error: string | null };

/**
 * Parses a user-entered dollar amount into microdollars.
 *
 * An empty string (and an explicit "0") is treated as "no allocation" rather
 * than an error. Commas are tolerated as thousands separators. Anything that
 * isn't a non-negative decimal with at most two fraction digits is rejected.
 */
export function parseDollarInput(raw: string): ParsedDollarInput {
  const trimmed = raw.trim();
  if (trimmed === '') return { microdollars: 0, error: null };

  const normalized = trimmed.replace(/,/g, '');
  if (!/^\d*\.?\d*$/.test(normalized) || normalized === '.') {
    return { microdollars: 0, error: 'Enter a valid amount' };
  }
  if (/\.\d{3,}$/.test(normalized)) {
    return { microdollars: 0, error: 'Use at most 2 decimal places' };
  }

  const value = Number(normalized);
  // Guards against pathological inputs (e.g. a very long digit string parsing
  // to Infinity); the regex above already excludes negatives and non-numerics.
  if (!Number.isFinite(value)) {
    return { microdollars: 0, error: 'Enter a valid amount' };
  }
  if (value === 0) return { microdollars: 0, error: null };
  return { microdollars: toMicrodollars(value), error: null };
}
