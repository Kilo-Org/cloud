import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSessionId,
  type PreparationAttempt,
  type SessionSnapshotPage,
  type SessionSnapshotPageOutcome,
} from '@kilocode/cloud-agent-sdk';

type SessionMessagesPageResult = {
  kiloSessionId: string;
  history: KiloSdkMessageHistory | null;
  watermarkEventId?: number | null;
  preparationAttempts?: PreparationAttempt[];
};

export type SessionPageTrpcClient = {
  cliSessionsV2: {
    getSessionMessagesPage: {
      query: (input: { session_id: string; cursor?: string }) => Promise<SessionMessagesPageResult>;
    };
  };
};

function isHistoryPage(history: KiloSdkMessageHistory): history is KiloSdkMessageHistoryPage {
  return 'messages' in history && Array.isArray(history.messages);
}

export async function fetchWebSessionSnapshotPage(
  trpcClient: SessionPageTrpcClient,
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
): Promise<SessionSnapshotPageOutcome> {
  const result = await trpcClient.cliSessionsV2.getSessionMessagesPage.query({
    session_id: kiloSessionId,
    ...(options.cursor ? { cursor: options.cursor } : {}),
  });

  const history = result.history;
  const pageState = {
    ...(result.watermarkEventId != null ? { watermarkEventId: result.watermarkEventId } : {}),
    ...(result.preparationAttempts?.length
      ? { preparationAttempts: result.preparationAttempts }
      : {}),
  };
  if (history === null) {
    return {
      kind: 'success',
      info: { id: result.kiloSessionId },
      messages: [],
      nextCursor: null,
      omittedItemCount: 0,
      ...pageState,
    };
  }

  if (isHistoryPage(history)) {
    return {
      kind: 'success',
      info: { id: result.kiloSessionId },
      messages: history.messages as SessionSnapshotPage['messages'],
      nextCursor: history.nextCursor,
      omittedItemCount: history.omittedItemCount,
      ...pageState,
    };
  }

  return history;
}
