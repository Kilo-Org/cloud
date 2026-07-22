import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSessionId,
  type SessionSnapshotPage,
  type SessionSnapshotPageOutcome,
} from 'cloud-agent-sdk';
import { trpcClient } from '@/lib/trpc';

/**
 * Type guard to narrow KiloSdkMessageHistory to the page variant.
 * The shared union is discriminated by the presence of the `messages` array.
 */
function isHistoryPage(history: KiloSdkMessageHistory): history is KiloSdkMessageHistoryPage {
  return 'messages' in history && Array.isArray(history.messages);
}

/**
 * Fetch a bounded page of session messages for the mobile client.
 *
 * Maps the shared `KiloSdkMessageHistory` union to the SDK's
 * `SessionSnapshotPageOutcome`:
 * - Page variant → success outcome with messages, cursor, and omitted count
 * - Failure variants → passed through verbatim (retryable, too_large, invalid_data)
 * - Null history → empty success page (existing session with zero messages). A genuine
 *   NOT_FOUND is returned as a thrown/rejected TRPCError, never as `history === null`.
 *
 * The adapter does not re-validate the tRPC response; it trusts the shared
 * contract and uses structural narrowing to distinguish page from failure.
 */
export async function fetchMobileSessionSnapshotPage(
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
): Promise<SessionSnapshotPageOutcome> {
  const result = await trpcClient.cliSessionsV2.getSessionMessagesPage.query({
    session_id: kiloSessionId,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });

  const history = result.history as KiloSdkMessageHistory | null;
  if (history === null) {
    return {
      kind: 'success',
      info: { id: result.kiloSessionId },
      messages: [],
      nextCursor: null,
      omittedItemCount: 0,
    };
  }

  if (isHistoryPage(history)) {
    return {
      kind: 'success',
      info: { id: result.kiloSessionId },
      messages: history.messages as SessionSnapshotPage['messages'],
      nextCursor: history.nextCursor,
      omittedItemCount: history.omittedItemCount,
    };
  }

  return history;
}
