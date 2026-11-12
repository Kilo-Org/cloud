import type { CloudSessionMessagesWirePage } from '@kilocode/cloud-agent-sdk/schemas';
import {
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSessionId,
  type CloudAgentSessionId,
  type PreparationAttempt,
  type SessionSnapshotPage,
  type SessionSnapshotPageOutcome,
} from '@kilocode/cloud-agent-sdk';
import { cloudSessionMessagesPageWireSchema } from '@kilocode/cloud-agent-sdk/schemas';

type SessionReadOptions = { context: { skipBatch: boolean } };
const SESSION_READ_OPTIONS: SessionReadOptions = { context: { skipBatch: true } };
const INITIAL_WEB_HISTORY_PAGE_SIZE = 20;

type SessionMessagesPageResult = {
  kiloSessionId: string;
  history: KiloSdkMessageHistory | null;
  watermarkEventId?: number | null;
  preparationAttempts?: PreparationAttempt[];
};

export type SessionPageTrpcClient = {
  cliSessionsV2: {
    getSessionMessagesPage: {
      query: (
        input: { session_id: string; cursor?: string; limit?: number },
        options?: SessionReadOptions
      ) => Promise<SessionMessagesPageResult>;
    };
  };
};

type CloudSessionPageInput = {
  sessionId: string;
  kiloSessionId?: string;
  cursor?: string;
  limit?: number;
  toolDisplay?: 'preview';
};

export type CloudSessionPageTrpcClient = {
  cloudAgentNext: {
    getSessionMessagesPage: {
      query: (input: CloudSessionPageInput, options?: SessionReadOptions) => Promise<unknown>;
    };
  };
  organizations: {
    cloudAgentNext: {
      getSessionMessagesPage: {
        query: (
          input: CloudSessionPageInput & { organizationId: string },
          options?: SessionReadOptions
        ) => Promise<unknown>;
      };
    };
  };
};

export async function fetchWebCloudSessionSnapshotPage(
  trpcClient: CloudSessionPageTrpcClient,
  sessionId: CloudAgentSessionId,
  options: { organizationId?: string; kiloSessionId?: string; cursor?: string; limit?: number }
): Promise<CloudSessionMessagesWirePage> {
  const { organizationId, limit, ...pageOptions } = options;
  const pageLimit = limit ?? (pageOptions.cursor ? undefined : INITIAL_WEB_HISTORY_PAGE_SIZE);
  // Completed tool bodies arrive as bounded previews; expanded cards read the complete call.
  const input = {
    sessionId,
    ...pageOptions,
    toolDisplay: 'preview' as const,
    ...(pageLimit === undefined ? {} : { limit: pageLimit }),
  };
  const result = organizationId
    ? await trpcClient.organizations.cloudAgentNext.getSessionMessagesPage.query(
        { ...input, organizationId },
        SESSION_READ_OPTIONS
      )
    : await trpcClient.cloudAgentNext.getSessionMessagesPage.query(input, SESSION_READ_OPTIONS);
  return cloudSessionMessagesPageWireSchema.parse(result);
}

function isHistoryPage(history: KiloSdkMessageHistory): history is KiloSdkMessageHistoryPage {
  return 'messages' in history && Array.isArray(history.messages);
}

export async function fetchWebSessionSnapshotPage(
  trpcClient: SessionPageTrpcClient,
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
): Promise<SessionSnapshotPageOutcome> {
  const result = await trpcClient.cliSessionsV2.getSessionMessagesPage.query(
    {
      session_id: kiloSessionId,
      ...(options.cursor ? { cursor: options.cursor } : { limit: INITIAL_WEB_HISTORY_PAGE_SIZE }),
    },
    SESSION_READ_OPTIONS
  );

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
