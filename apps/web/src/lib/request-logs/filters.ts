export const REQUEST_LOGS_LIMIT = 100;
export const REQUEST_LOGS_WINDOW_HOURS = 1;
export const REQUEST_LOGS_START_TIME_MAX_AGE_DAYS = 365;
export const REQUEST_LOGS_MODEL_PREFIX_MAX_LENGTH = 200;
export const ENKRYPT_USAGE_WINDOW_HOURS = 24;

/** `flagged` is an allowed call on which a log-only detector fired. */
export const ENKRYPT_USAGE_OUTCOMES = ['allowed', 'flagged', 'blocked', 'error'] as const;
export type EnkryptUsageOutcome = (typeof ENKRYPT_USAGE_OUTCOMES)[number];

const START_TIME_MAX_FUTURE_MS = 5 * 60 * 1000;

/** Allows a few minutes of clock skew between the browser and the server. */
export function isRequestLogStartTimeInBounds(startTime: number, now: number): boolean {
  return (
    startTime >= now - REQUEST_LOGS_START_TIME_MAX_AGE_DAYS * 24 * 60 * 60 * 1000 &&
    startTime <= now + START_TIME_MAX_FUTURE_MS
  );
}
