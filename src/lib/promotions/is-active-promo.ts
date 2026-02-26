/**
 * Shared helper for time-limited, origin-gated free-model promotions.
 *
 * Each promo is described by a PromoConfig: a model slug, a JWT field + value
 * that identifies eligible traffic, and a time window. `isActivePromo` checks
 * all three conditions in one place so callers don't have to duplicate logic.
 */

export type PromoConfig = {
  /** JWT field that identifies the traffic source (e.g. 'botId' or 'tokenSource'). */
  sourceField: 'botId' | 'tokenSource';
  /** Expected value of the JWT field for this promo. */
  sourceValue: string;
  /** Model slug that is free during the promo. */
  model: string;
  /** ISO-8601 start timestamp (inclusive). If omitted, the promo is active from the beginning of time. */
  start?: string;
  /** ISO-8601 end timestamp (exclusive). */
  end: string;
};

/**
 * Returns true when `actualSource` matches the promo's expected JWT value,
 * `actualModel` matches the promo model, and the current time is within the
 * promo window.
 */
export function isActivePromo(
  config: PromoConfig,
  actualSource: string | undefined,
  actualModel: string
): boolean {
  if (actualSource !== config.sourceValue) return false;
  if (actualModel !== config.model) return false;

  const now = Date.now();
  if (config.start && now < Date.parse(config.start)) return false;
  return now < Date.parse(config.end);
}
