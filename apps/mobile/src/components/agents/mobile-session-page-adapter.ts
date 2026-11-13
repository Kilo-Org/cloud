import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSessionId,
  type SessionSnapshotPage,
  type SessionSnapshotPageOutcome,
} from '@kilocode/cloud-agent-sdk';
import { trpcClient } from '@/lib/trpc';

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
 * Both success arms also carry the page's preparation rows, which are not part
 * of the message history: a run whose sandbox preparation failed has zero
 * messages, and opening it shows its own failed stage and reason (with the
 * question row's Retry and Copy) instead of an empty transcript.
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
  // The rows a message page cannot carry, shared by both success arms. The
  // preparation rows come first: a run whose sandbox preparation failed has no
  // messages at all, and without them the open would paint an empty transcript
  // instead of the run's own failure. Omitted when the router sends none, so
  // the SDK's restore keeps the live rows it already holds.
  // Mobile ships independently of the API: an older server omits the rows, so
  // the page is read structurally rather than trusted.
  const preparationAttempts = Array.isArray(result.preparationAttempts)
    ? result.preparationAttempts
    : [];
  const pageState = {
    ...(result.watermarkEventId != null ? { watermarkEventId: result.watermarkEventId } : {}),
    ...(preparationAttempts.length > 0 ? { preparationAttempts } : {}),
  };
  if (history === null) {
    return {
      parentSessionId,
      outcome: {
        kind: 'success',
        info,
        messages: [],
        nextCursor: null,
        omittedItemCount: 0,
        ...pageState,
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
        ...pageState,
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
