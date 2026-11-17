import { DEFAULT_INTERVAL_SECONDS, MAX_INTERVAL_SECONDS, MIN_INTERVAL_SECONDS } from './constants';

/**
 * Turns the `SCIM_POLL_INTERVAL_SECONDS` var into a delay `setAlarm` can take.
 *
 * `vars` are strings, so a blank or unparseable value must not reach it. Blank
 * is checked before parsing because `Number('')` is `0`, which is finite and
 * would clamp to the floor rather than fall back to the default.
 */
export function clampPollIntervalSeconds(raw: string | undefined): number {
  const trimmed = (raw ?? '').trim();
  if (trimmed === '') return DEFAULT_INTERVAL_SECONDS;

  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) return DEFAULT_INTERVAL_SECONDS;
  return Math.min(Math.max(Math.trunc(parsed), MIN_INTERVAL_SECONDS), MAX_INTERVAL_SECONDS);
}
