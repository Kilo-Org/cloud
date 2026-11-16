import { i18n } from '@/i18n';
import { formatPrefixedUsd, normalizeLocalizedNumber } from '@/lib/format';

/** Why a field's text is not yet a submittable amount. */
type AmountProblem = 'empty' | 'unparsable' | 'aboveMaximum' | 'belowMinimum';

/** One field reading: a problem, or the parsed amount — never both. */
export type AmountReading = Readonly<{ amount: number | null; problem: AmountProblem | null }>;

/** The inclusive bounds a field's value must sit inside to be submittable. */
export type AmountBounds = Readonly<{ minimum: number; maximum: number }>;

/**
 * Read a localized amount against bounds, where `acceptsMinimum` decides
 * whether the floor itself is a submittable value (`bounds.minimum` inclusive)
 * or values at the floor and below are out of range. The magnitude is compared
 * on the normalized literal, because a pasted number too large for a JS number
 * still has a magnitude — it reads as `Infinity`, which is above any cap — while
 * the text itself is exactly the kind of input the field must report as too big.
 * Out-of-range amounts are never clamped.
 */
function readAmount(value: string, bounds: AmountBounds, acceptsMinimum: boolean): AmountReading {
  const normalized = normalizeLocalizedNumber(value, i18n.language);
  if (normalized === null) {
    return {
      amount: null,
      problem: value.trim() === '' ? ('empty' as const) : ('unparsable' as const),
    };
  }
  const amount = Number(normalized);
  if (amount > bounds.maximum) {
    return { amount: null, problem: 'aboveMaximum' };
  }
  if (amount < bounds.minimum || (!acceptsMinimum && amount === bounds.minimum)) {
    return { amount: null, problem: 'belowMinimum' };
  }
  return { amount, problem: null };
}

/**
 * Read a localized amount against inclusive bounds: an amount at either bound
 * is submittable, values outside them carry no magnitude.
 */
export function readAmountWithin(value: string, bounds: AmountBounds): AmountReading {
  return readAmount(value, bounds, true);
}

/**
 * Read a localized amount that any positive value accepts: zero, its minimum,
 * is refused (`belowMinimum`) rather than parsed as `0`.
 */
export function readAmountAtMost(value: string, maximum: number): AmountReading {
  return readAmount(value, { minimum: 0, maximum }, false);
}

/** The field's above-the-cap sentence, naming the cap as a whole USD amount. */
export function aboveMaximumError(maximum: number): string {
  return i18n.t('spendAlerts.thresholdMaxError', {
    max: formatPrefixedUsd(maximum, i18n.language, {
      minimumFractionDigits: 0,
      maximumFractionDigits: 0,
    }),
  });
}
