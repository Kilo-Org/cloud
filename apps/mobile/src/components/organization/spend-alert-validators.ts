import { i18n } from '@/i18n';
import { formatCurrency, formatNumber, normalizeLocalizedNumber } from '@/lib/format';

/**
 * Bounds the save payload's schema enforces, mirrored here so the form shows an
 * inline error instead of a rejected save: one million dollars and 50x (the
 * wire's basis-point cap of 5000) are the schema's own limits.
 */
const MAX_THRESHOLD_USD = 1_000_000;
const MAX_MULTIPLIER = 50;

/**
 * Smallest limit that survives the wire's conversion to microdollars. The
 * router stores `round(threshold * 1_000_000)`, so a smaller positive value
 * would round to a zero-microdollar threshold: the rule then fires on any
 * spend and its 95% hysteresis band is zero, so it never clears.
 */
const MIN_THRESHOLD_USD = 0.000_001;

/** The rolling windows the wire accepts, in hours. */
export type SpendAlertWindowHours = 24 | 168 | 720;

/** A scope that has never chosen a window alerts on the trailing 24 hours. */
export const DEFAULT_WINDOW_HOURS: SpendAlertWindowHours = 24;

/** A scope that has never chosen a multiplier starts at double its usual rate. */
export const DEFAULT_MULTIPLIER = 2;

/**
 * The value the save payload carries for an alert kind the owner has switched
 * off. The wire requires a limit and a multiplier whichever kinds are enabled,
 * so a switched-off kind submits the smallest value its schema accepts rather
 * than making the owner fill in a field for an alert that will not fire.
 */
export const DISABLED_THRESHOLD_USD = 1;
export const DISABLED_MULTIPLIER = 1;

/** The inclusive bounds a field's value must sit inside to be submittable. */
type Bounds = Readonly<{ minimum: number; maximum: number }>;

const THRESHOLD_BOUNDS: Bounds = { minimum: MIN_THRESHOLD_USD, maximum: MAX_THRESHOLD_USD };
const MULTIPLIER_BOUNDS: Bounds = { minimum: 1, maximum: MAX_MULTIPLIER };

/**
 * Read a localized amount against inclusive bounds. The magnitude is compared on
 * the normalized literal, because a pasted number too large for a JS number
 * still has a magnitude — it reads as `Infinity`, which is above any cap — while
 * the text itself is exactly the kind of input the field must report as too big.
 */
function readAmount(value: string, bounds: Bounds) {
  const normalized = normalizeLocalizedNumber(value, i18n.language);
  if (normalized === null) {
    return {
      amount: null,
      problem: value.trim() === '' ? ('empty' as const) : ('unparsable' as const),
    };
  }
  const amount = Number(normalized);
  if (amount > bounds.maximum) {
    return { amount: null, problem: 'aboveMaximum' as const };
  }
  if (amount < bounds.minimum) {
    return { amount: null, problem: 'belowMinimum' as const };
  }
  return { amount, problem: null };
}

/** Parse a USD limit: out-of-range values are `null` (no limit), never clamped. */
export function parseThreshold(value: string): number | null {
  return readAmount(value, THRESHOLD_BOUNDS).amount;
}

/** Parse the anomaly multiplier: at least 1x, at most the wire's 50x cap. */
export function parseMultiplier(value: string): number | null {
  return readAmount(value, MULTIPLIER_BOUNDS).amount;
}

/** The wire stores the multiplier in basis points, where 100 is 1x. */
export function multiplierBasisPoints(multiplier: number): number {
  return Math.round(multiplier * 100);
}

/** A window read back from the wire, narrowed to the three the wire accepts. */
export function toWindowHours(value: number | null | undefined): SpendAlertWindowHours {
  if (value === 168 || value === 720) {
    return value;
  }
  return DEFAULT_WINDOW_HOURS;
}

/** Inline error for the limit field, or `null` while the value is valid. */
export function thresholdError(value: string): string | null {
  const { problem } = readAmount(value, THRESHOLD_BOUNDS);
  if (problem === null) {
    return null;
  }
  if (problem === 'aboveMaximum') {
    return i18n.t('spendAlerts.thresholdMaxError', {
      max: formatCurrency(MAX_THRESHOLD_USD, i18n.language, 0),
    });
  }
  // Empty, unparsable, and below the smallest storable amount share the billing
  // alert's copy: the same sentence, so the two fields can never drift apart in
  // a translation.
  return i18n.t('organization.lowBalanceAlert.thresholdError');
}

/** Inline error for the multiplier field, or `null` while the value is valid. */
export function multiplierError(value: string): string | null {
  const { problem } = readAmount(value, MULTIPLIER_BOUNDS);
  if (problem === null) {
    return null;
  }
  if (problem === 'aboveMaximum') {
    return i18n.t('spendAlerts.multiplierMaxError', {
      max: formatNumber(MAX_MULTIPLIER, i18n.language),
    });
  }
  return i18n.t('spendAlerts.multiplierError');
}
