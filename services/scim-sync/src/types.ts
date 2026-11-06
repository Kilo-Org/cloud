/**
 * Durable Object RPC and status shapes.
 *
 * These are internal contracts between the Worker and its Durable Object, not
 * data crossing an IO boundary, so they are plain types rather than Zod
 * schemas. The WorkOS response is validated by the SDK's own deserializers and
 * typed by its exported `Event` union; the app's responses are parsed in
 * `dispatch/`.
 */

import type { AttemptClass } from './dispatch/app-client';

/** Which of the two cursor sources the loop is running on. */
export type CursorSource =
  /** Nothing stored and no var: the Events API returns the oldest events. */
  | 'none'
  /** Stored state won, which is the steady state. */
  | 'stored'
  /** `WORKOS_EVENT_CURSOR` differed from the stored seed and reset the stream. */
  | 'var';

/** The event the loop is currently stuck on. At most one, consumed serially. */
export type EventFailureState = {
  eventId: string;
  eventType: string;
  attempts: number;
  lastClass: AttemptClass;
  lastStatus: number | null;
  lastError: string;
  firstFailedAt: number;
  lastAttemptAt: number;
};

/** Outcome of one poll, persisted so `/status` survives hibernation. */
export type PollResult = {
  at: string;
  /** Events returned across every page this poll fetched. */
  eventCount: number;
  /** Events whose every call applied, and whose cursor was committed. */
  eventsApplied: number;
  /** Events stepped over: a terminal outcome, or a conflict out of budget. */
  eventsParked: number;
  /** ID of the last event seen, applied or not. */
  lastEventId: string | null;
  /** The committed cursor when the poll finished. */
  cursor: string | null;
  cursorSource: CursorSource;
  /**
   * True when the last page came back short, which is the stream saying there
   * is nothing more to read. False means the drain budget ran out mid-backlog.
   */
  caughtUp: boolean;
  /** Set when the poll stopped on a held failure; the cursor did not move. */
  heldFailure: EventFailureState | null;
  /** A poll-level failure: the Events API itself, or an unexpected throw. */
  error: string | null;
};

export type ScimSyncDOStatus = {
  instance: string;
  environment: string;
  pollIntervalSeconds: number;
  cursor: string | null;
  cursorSource: CursorSource;
  /** Non-null whenever the loop is stuck, which is what an operator looks for. */
  eventFailure: EventFailureState | null;
  /** Events the loop gave up on and stepped over, over the object's lifetime. */
  parkedCount: number;
  nextAlarmAt: number | null;
  lastPoll: PollResult | null;
};
