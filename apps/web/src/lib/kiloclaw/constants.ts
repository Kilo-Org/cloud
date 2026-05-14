import { LEGACY_KILOCLAW_PRICE_VERSION, getKiloClawPricingCatalogEntry } from '@kilocode/db';

/** Earlybird hosting access expires on this date for all earlybird purchasers. */
export const KILOCLAW_EARLYBIRD_EXPIRY_DATE = '2026-09-26';

/** Legacy trial duration used by historical earlybird/trial alignment scripts. */
export const KILOCLAW_TRIAL_DURATION_DAYS = getKiloClawPricingCatalogEntry(
  LEGACY_KILOCLAW_PRICE_VERSION
).trialDurationDays;
