import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSessionId,
  type SessionSnapshotPage,
  type SessionSnapshotPageOutcome,
} from '@kilocode/cloud-agent-sdk';
import { trpcClient } from '@/lib/trpc';

/**
 * Message and tRPC-style code for a typed worker failure of the paged read.
 * One source for the preview's error state and the manager's snapshot replay:
 * `retryable_failure` stays retryable, the terminal kinds do not.
 */
export const SESSION_HISTORY_FAILURES = {
  retryable_failure: {
    message: 'Session history temporarily unavailable',
    code: 'INTERNAL_SERVER_ERROR',
  },
  too_large: { message: 'Session history too large to load', code: 'UNPROCESSABLE_CONTENT' },
  invalid_data: { message: 'Session history is unavailable', code: 'UNPROCESSABLE_CONTENT' },
} as const;

/** A typed worker failure, carrying the `code` the query error readers classify on. */
export class SessionHistoryFailureError extends Error {
  readonly code: string;

  constructor(failure: { message: string; code: string }) {
    super(failure.message);
    this.code = failure.code;
  }
}

/**
 * Type guard to narrow KiloSdkMessageHistory to the page variant.
 * The shared union is discriminated by the presence of the `messages` array.
 */
function isHistoryPage(history: KiloSdkMessageHistory): history is KiloSdkMessageHistoryPage {
  return 'messages' in history && Array.isArray(history.messages);
}

/** A page read plus the parent id the same payload carried. */
export type MobileSessionSnapshotRead = {
  outcome: SessionSnapshotPageOutcome;
  /** `null` is an answer — a root session; `undefined` means the payload lacks it. */
  parentSessionId: string | null | undefined;
};

/**
 * Read a bounded page of session messages for the mobile client.
 *
 * Maps the shared `KiloSdkMessageHistory` union to the SDK's
 * `SessionSnapshotPageOutcome`:
 * - Page variant → success outcome with messages, cursor, omitted count,
 *   and the Cloud Agent event-log watermark
 * - Failure variants → passed through verbatim (retryable, too_large, invalid_data)
 * - Null history → empty success page (existing session with zero messages). A genuine
 *   NOT_FOUND is returned as a thrown/rejected TRPCError, never as `history === null`.
 *
 * The adapter does not re-validate the tRPC response; it trusts the shared
 * contract and uses structural narrowing to distinguish page from failure.
 *
 * The parent id is returned beside the outcome rather than folded into its
 * `info`: the transport replays that `info` as `session.created`, and a page
 * that reports a parent there would enter the SDK's root-session bookkeeping as
 * a child, which is not what the opened session is.
 */
export async function readMobileSessionSnapshotPage(
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
): Promise<MobileSessionSnapshotRead> {
  const result = await trpcClient.cliSessionsV2.getSessionMessagesPage.query({
    session_id: kiloSessionId,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });
  // The router always projects the parent id, but mobile ships independently of
  // the API: an older server omits the field, so it is read as optional here.
  // The assignment widens `result` structurally; it is not an assertion.
  const payload: { parentSessionId?: string | null } = result;
  const parentSessionId = payload.parentSessionId;

  // The goal lives in the session metadata, which the messages page carries
  // alongside the bounded history. Rebuilding `info` from the page (instead
  // of `{ id }`) keeps the fixed goal section across open and reconnect: the
  // transport replays this `info` as `session.created`, which otherwise
  // clobbers the goal held in the live session state.
  const info: SessionSnapshotPage['info'] = {
    id: result.kiloSessionId,
    ...(result.sessionGoal ? { goal: result.sessionGoal } : {}),
  };

  const history = result.history as KiloSdkMessageHistory | null;
  if (history === null) {
    return {
      parentSessionId,
      outcome: {
        kind: 'success',
        info,
        messages: [],
        nextCursor: null,
        omittedItemCount: 0,
        watermarkEventId: result.watermarkEventId ?? undefined,
      },
    };
  }

  if (isHistoryPage(history)) {
    return {
      parentSessionId,
      outcome: {
        kind: 'success',
        info,
        messages: history.messages as SessionSnapshotPage['messages'],
        nextCursor: history.nextCursor,
        omittedItemCount: history.omittedItemCount,
        watermarkEventId: result.watermarkEventId ?? undefined,
      },
    };
  }

  return { parentSessionId, outcome: history };
}

/** The page outcome alone, for callers that do not read the parent id. */
export async function fetchMobileSessionSnapshotPage(
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
): Promise<SessionSnapshotPageOutcome> {
  const { outcome } = await readMobileSessionSnapshotPage(kiloSessionId, options);
  return outcome;
}
