/**
 * The window arithmetic behind the request-log pager: the hour the procedure
 * lists, and the age bound its start time must stay inside.
 */

/**
 * The hour the procedure lists: `organizations.requestLogs.list` answers the
 * rows created in the hour before `startTime`, so a window end is the screen's
 * paging control and one step is one hour.
 */
export const HOUR_MS = 60 * 60 * 1000;

/**
 * The procedure refuses a start time more than `REQUEST_LOGS_START_TIME_MAX_AGE_DAYS`
 * (365, apps/web) before its own clock, which runs later than this screen's
 * mount-time anchor. The stepper keeps an hour of margin, so the oldest window
 * it opens still names a start time the server accepts.
 */
export const HISTORY_DAYS = 365;

/** Whether a window ending at `windowEndMs` is inside the procedure's age bound. */
export function canStepOlderTo(windowEndMs: number, anchorMs: number): boolean {
  return windowEndMs >= anchorMs - (HISTORY_DAYS * 24 - 1) * HOUR_MS;
}
