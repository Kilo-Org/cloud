import * as z from 'zod';

// Personal auto-top-up settings
export const AUTO_TOP_UP_THRESHOLD_DOLLARS = 5;
export const AUTO_TOP_UP_AMOUNTS_CENTS = [2000, 5000, 10000] as const;
export const DEFAULT_AUTO_TOP_UP_AMOUNT_CENTS: AutoTopUpAmountCents = 5000;
export const AutoTopUpAmountCentsSchema = z.union(AUTO_TOP_UP_AMOUNTS_CENTS.map(n => z.literal(n)));
export type AutoTopUpAmountCents = z.infer<typeof AutoTopUpAmountCentsSchema>;

// Organization auto-top-up settings (higher amounts to match org one-time purchase)
export const ORG_AUTO_TOP_UP_THRESHOLD_DOLLARS = 50;
export const ORG_AUTO_TOP_UP_AMOUNTS_CENTS = [10000, 50000, 100000] as const;
export const OrgAutoTopUpAmountCentsSchema = z.union(
  ORG_AUTO_TOP_UP_AMOUNTS_CENTS.map(n => z.literal(n))
);
export type OrgAutoTopUpAmountCents = z.infer<typeof OrgAutoTopUpAmountCentsSchema>;
export const DEFAULT_ORG_AUTO_TOP_UP_AMOUNT_CENTS: OrgAutoTopUpAmountCents = 50000;

// An in-flight auto-top-up holds its lock until the `invoice.paid` webhook posts
// credits. A lock older than this is stale and can be reclaimed.
export const AUTO_TOP_UP_ATTEMPT_LOCK_TIMEOUT_SECONDS = 60 * 60 * 2; // 2 hours

// A blocked request is reported as retryable only while a top-up is plausibly
// still in transit. A delivered `invoice.paid` webhook clears the lock within
// seconds, so this is deliberately shorter than the reclaim timeout: a lost
// webhook must not mask a terminal no-credits state for hours.
export const AUTO_TOP_UP_IN_FLIGHT_WINDOW_SECONDS = 15 * 60; // 15 minutes

export const SYSTEM_AUTO_TOP_UP_USER_ID = 'system-auto-topup';
