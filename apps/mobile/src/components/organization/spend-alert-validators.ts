import { i18n } from '@/i18n';
import { parseLocalizedNumber } from '@/lib/format';

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

/**
 * Parse a USD limit: an empty, unparsable, zero, negative, sub-microdollar, or
 * above-cap value is `null` (no limit), never a clamped number.
 */
export function parseThreshold(value: string): number | null {
  const trimmed = value.trim();
  const parsed = parseLocalizedNumber(trimmed, i18n.language);
  if (
    trimmed === '' ||
    parsed === null ||
    parsed < MIN_THRESHOLD_USD ||
    parsed > MAX_THRESHOLD_USD
  ) {
    return null;
  }
  return parsed;
}

/** Parse the anomaly multiplier: at least 1x, at most the wire's 50x cap. */
export function parseMultiplier(value: string): number | null {
  const trimmed = value.trim();
  const parsed = parseLocalizedNumber(trimmed, i18n.language);
  if (trimmed === '' || parsed === null || parsed < 1 || parsed > MAX_MULTIPLIER) {
    return null;
  }
  return parsed;
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
  // Reuses the billing alert's copy: the same sentence, so the two fields can
  // never drift apart in a translation.
  return parseThreshold(value) == null
    ? i18n.t('organization.lowBalanceAlert.thresholdError')
    : null;
}

/** Inline error for the multiplier field, or `null` while the value is valid. */
export function multiplierError(value: string): string | null {
  return parseMultiplier(value) == null ? i18n.t('spendAlerts.multiplierError') : null;
}
