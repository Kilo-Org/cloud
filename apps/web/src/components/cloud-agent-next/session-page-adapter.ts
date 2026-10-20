import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSessionId,
  type CloudAgentSessionId,
  type CloudSessionSnapshotPage,
  type PreparationAttempt,
  type SessionSnapshotPage,
  type SessionSnapshotPageOutcome,
} from '@kilocode/cloud-agent-sdk';
import { cloudSessionMessagesPageSchema } from '@kilocode/cloud-agent-sdk/schemas';

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

type CloudSessionPageInput = {
  sessionId: string;
  kiloSessionId?: string;
  cursor?: string;
  limit?: number;
};

export type CloudSessionPageTrpcClient = {
  cloudAgentNext: {
    getSessionMessagesPage: { query: (input: CloudSessionPageInput) => Promise<unknown> };
  };
  organizations: {
    cloudAgentNext: {
      getSessionMessagesPage: {
        query: (input: CloudSessionPageInput & { organizationId: string }) => Promise<unknown>;
      };
    };
  };
};

export async function fetchWebCloudSessionSnapshotPage(
  trpcClient: CloudSessionPageTrpcClient,
  sessionId: CloudAgentSessionId,
  options: { organizationId?: string; kiloSessionId?: string; cursor?: string; limit?: number }
): Promise<CloudSessionSnapshotPage | null> {
  const { organizationId, ...pageOptions } = options;
  const input = { sessionId, ...pageOptions };
  const result = organizationId
    ? await trpcClient.organizations.cloudAgentNext.getSessionMessagesPage.query({
        ...input,
        organizationId,
      })
    : await trpcClient.cloudAgentNext.getSessionMessagesPage.query(input);
  return cloudSessionMessagesPageSchema.parse(result);
}

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
