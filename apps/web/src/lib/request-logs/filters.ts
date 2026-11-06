export const REQUEST_LOGS_LIMIT = 100;
export const REQUEST_LOGS_WINDOW_HOURS = 1;
export const REQUEST_LOGS_START_TIME_MAX_AGE_DAYS = 365;
export const REQUEST_LOGS_MODEL_PREFIX_MAX_LENGTH = 200;

const START_TIME_MAX_FUTURE_MS = 5 * 60 * 1000;

/** Allows a few minutes of clock skew between the browser and the server. */
export function isRequestLogStartTimeInBounds(startTime: number, now: number): boolean {
  return (
    startTime >= now - REQUEST_LOGS_START_TIME_MAX_AGE_DAYS * 24 * 60 * 60 * 1000 &&
    startTime <= now + START_TIME_MAX_FUTURE_MS
  );
}
