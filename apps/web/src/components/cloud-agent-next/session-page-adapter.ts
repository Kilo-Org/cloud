import * as Sentry from '@sentry/nextjs';
import type { CloudSessionMessagesWirePage } from '@kilocode/cloud-agent-sdk/schemas';
import {
  RETAINED_MESSAGE_WINDOW,
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type KiloSessionId,
  type CloudAgentSessionId,
  type PreparationAttempt,
  type SessionSnapshotPage,
  type SessionSnapshotPageOutcome,
} from '@kilocode/cloud-agent-sdk';
import { cloudSessionMessagesPageWireSchema } from '@kilocode/cloud-agent-sdk/schemas';
import { z } from 'zod';

type SessionReadOptions = { context: { skipBatch: boolean } };
const SESSION_READ_OPTIONS: SessionReadOptions = { context: { skipBatch: true } };
const INITIAL_WEB_HISTORY_PAGE_SIZE = 100;
const INITIAL_CLI_HISTORY_PAGE_SIZE = 20;
const INITIAL_HISTORY_USER_TURNS = 2;
const MAX_INITIAL_HISTORY_PAGES = 5;
const MAX_INITIAL_HISTORY_BYTES = 4 * 1024 * 1024;

const historyUserMessageSchema = z.union([
  z
    .object({ info: z.object({ id: z.string(), role: z.literal('user') }) })
    .transform(m => m.info.id),
  z
    .object({ message: z.object({ id: z.string(), type: z.enum(['user', 'synthetic']) }) })
    .transform(m => m.message.id),
]);

async function loadRecentUserTurns<
  Page extends { messages: unknown[]; nextCursor: string | null; omittedItemCount: number },
>(first: Page, load: (cursor: string) => Promise<Page | null>): Promise<Page> {
  let page = first;
  let bytes = new TextEncoder().encode(JSON.stringify(first)).byteLength;
  const users = new Set<string>();
  const cursors = new Set<string>();
  const countUsers = (messages: unknown[]) => {
    for (const message of messages) {
      const user = historyUserMessageSchema.safeParse(message);
      if (user.success) users.add(user.data);
    }
  };
  countUsers(first.messages);

  for (let count = 1; count < MAX_INITIAL_HISTORY_PAGES; count++) {
    const cursor = page.nextCursor;
    if (users.size >= INITIAL_HISTORY_USER_TURNS || !cursor || cursors.has(cursor)) break;
    if (bytes >= MAX_INITIAL_HISTORY_BYTES) break;
    cursors.add(cursor);
    let older: Page | null;
    try {
      older = await load(cursor);
    } catch (error) {
      Sentry.captureException(error, { tags: { source: 'initial-history-continuation' } });
      break;
    }
    if (!older || (older.nextCursor && cursors.has(older.nextCursor))) break;
    // The SDK never trims the initial page, so it must fit the retained window.
    if (page.messages.length + older.messages.length > RETAINED_MESSAGE_WINDOW) break;
    const olderBytes = new TextEncoder().encode(JSON.stringify(older)).byteLength;
    if (bytes + olderBytes > MAX_INITIAL_HISTORY_BYTES) break;
    bytes += olderBytes;
    countUsers(older.messages);
    page = {
      ...page,
      messages: [...older.messages, ...page.messages],
      nextCursor: older.nextCursor,
      omittedItemCount: page.omittedItemCount + older.omittedItemCount,
    };
  }
  return page;
}

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
  const read = async (pageInput: CloudSessionPageInput) => {
    const result = organizationId
      ? await trpcClient.organizations.cloudAgentNext.getSessionMessagesPage.query(
          { ...pageInput, organizationId },
          SESSION_READ_OPTIONS
        )
      : await trpcClient.cloudAgentNext.getSessionMessagesPage.query(
          pageInput,
          SESSION_READ_OPTIONS
        );
    return cloudSessionMessagesPageWireSchema.parse(result);
  };
  const first = await read(input);
  if (!first || options.cursor || limit !== undefined) return first;
  const page = await loadRecentUserTurns(first, async cursor => {
    const older = await read({ ...input, cursor, limit: undefined });
    if (older?.info.id !== first.info.id || older.source?.version !== first.source?.version) {
      return null;
    }
    return older;
  });
  return cloudSessionMessagesPageWireSchema.parse(page);
}

function isHistoryPage(history: KiloSdkMessageHistory): history is KiloSdkMessageHistoryPage {
  return 'messages' in history && Array.isArray(history.messages);
}

export async function fetchWebSessionSnapshotPage(
  trpcClient: SessionPageTrpcClient,
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
): Promise<SessionSnapshotPageOutcome> {
  const first = await readWebSessionSnapshotPage(trpcClient, kiloSessionId, options);
  if (first.kind !== 'success' || options.cursor) return first;
  return loadRecentUserTurns(first, async cursor => {
    const older = await readWebSessionSnapshotPage(trpcClient, kiloSessionId, { cursor });
    return older.kind === 'success' && older.info.id === first.info.id ? older : null;
  });
}

async function readWebSessionSnapshotPage(
  trpcClient: SessionPageTrpcClient,
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
): Promise<SessionSnapshotPageOutcome> {
  const result = await trpcClient.cliSessionsV2.getSessionMessagesPage.query(
    {
      session_id: kiloSessionId,
      ...(options.cursor ? { cursor: options.cursor } : { limit: INITIAL_CLI_HISTORY_PAGE_SIZE }),
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
