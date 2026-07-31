import { createTRPCClient } from '@trpc/client';
import {
  type CloudAgentSessionId,
  type FetchedSessionData,
  type JotaiStore,
  type KiloSessionId,
  type KiloSdkMessageHistory,
  type KiloSdkMessageHistoryPage,
  type ResolvedSession,
  type SessionManager,
  type SessionSnapshot,
  type SessionSnapshotPage,
  type SessionSnapshotPageOutcome,
  type UserWebConnection,
  createBrowserLifecycleHooks,
  createSessionManager,
} from '@kilocode/cloud-agent-sdk';
import type { MobileRouter, inferRouterOutputs } from '@kilocode/trpc/mobile';
import { getCloudAgentWsUrl } from './cloud-agent-config';

/** Flat 1s cadence — same budget as the session-detail route's spawned retry. */
const FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS = 1000;
/** Match the mobile `SPAWNED_NOT_FOUND_MAX_ATTEMPTS` for NOT_FOUND retry parity. */
const SPAWNED_NOT_FOUND_MAX_ATTEMPTS = 8;

const skipBatchOptions = { context: { skipBatch: true } } as const;

type TrpcClient = ReturnType<typeof createTRPCClient<MobileRouter>>;

// ---------------------------------------------------------------------------
// Error code extraction — extension-owned copy of the mobile classifier
// ---------------------------------------------------------------------------

/**
 * Walk tRPC error shapes for a code string.
 * Extension-owned copy; mirrors `readFetchSessionErrorCode` from the mobile
 * session-manager so the extension has no dependency on mobile internals.
 */
export function readFetchSessionErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const data = record['data'];
  if (data && typeof data === 'object') {
    const code = (data as Record<string, unknown>)['code'];
    if (typeof code === 'string') return code;
  }
  const shape = record['shape'];
  if (shape && typeof shape === 'object') {
    const shapeData = (shape as Record<string, unknown>)['data'];
    if (shapeData && typeof shapeData === 'object') {
      const code = (shapeData as Record<string, unknown>)['code'];
      if (typeof code === 'string') return code;
    }
  }
  const top = record['code'];
  if (typeof top === 'string') return top;
  return undefined;
}

// ---------------------------------------------------------------------------
// NOT_FOUND retry — extension-owned copy of the mobile retry loop
// ---------------------------------------------------------------------------

type SessionWithRuntimeState =
  inferRouterOutputs<MobileRouter>['cliSessionsV2']['getWithRuntimeState'];

export async function fetchSessionWithNotFoundRetry(
  kiloSessionId: KiloSessionId,
  options: {
    query: (id: KiloSessionId) => Promise<SessionWithRuntimeState>;
    sleep?: (ms: number) => Promise<void>;
  }
): Promise<SessionWithRuntimeState> {
  const sleep = options.sleep ?? defaultFetchSessionSleep;
  let attempt = 0;
  for (;;) {
    try {
      return await options.query(kiloSessionId);
    } catch (error) {
      if (
        readFetchSessionErrorCode(error) !== 'NOT_FOUND' ||
        attempt >= SPAWNED_NOT_FOUND_MAX_ATTEMPTS
      ) {
        throw error;
      }
      attempt += 1;
      await sleep(FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS);
    }
  }
}

async function defaultFetchSessionSleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(() => resolve(), ms);
  });
}

// ---------------------------------------------------------------------------
// Page-adapter helpers — extension-owned mirrors of the mobile page adapters
// ---------------------------------------------------------------------------

function isHistoryPage(history: KiloSdkMessageHistory): history is KiloSdkMessageHistoryPage {
  return 'messages' in history && Array.isArray(history.messages);
}

/**
 * Adapt `cliSessionsV2.getSessionMessagesPage` result to the SDK's
 * `SessionSnapshotPageOutcome` union. Extension-owned; mirrors the mobile
 * `fetchMobileSessionSnapshotPage` adapter.
 */
async function fetchExtensionSessionSnapshotPage(
  trpcClient: TrpcClient,
  kiloSessionId: KiloSessionId,
  options: { cursor?: string }
): Promise<SessionSnapshotPageOutcome | null> {
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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

type CreateExtensionAgentSessionManagerOptions = {
  store: JotaiStore;
  trpcClient: TrpcClient;
  /** Organization context. `null` = personal, a UUID = that organization. */
  organizationId: string | null;
  /** Token getter for auth headers. Returns the current Bearer token. */
  getToken: () => string | undefined;
  /** Kilo API base URL (injected so tests can provide a test origin). */
  apiBaseUrl: string;
  userWebConnection: UserWebConnection;
};

/**
 * Create a cloud-agent session manager for the browser extension.
 *
 * Ports the mobile session-manager's resolve / ticket / snapshot / API /
 * prepare / initiate / fetchSession patterns into extension-owned code with:
 * - injected `trpcClient`, `organizationId`, `getToken`, and `apiBaseUrl`
 * - `createBrowserLifecycleHooks` for extension-side panel lifecycle
 * - extension-owned `readFetchSessionErrorCode` and NOT_FOUND retry
 * - extension-owned page-adapter for paged snapshots
 */
export function createExtensionAgentSessionManager({
  store,
  trpcClient,
  organizationId,
  getToken,
  apiBaseUrl,
  userWebConnection,
}: Readonly<CreateExtensionAgentSessionManagerOptions>): SessionManager {
  return createSessionManager({
    store,
    websocketBaseUrl: getCloudAgentWsUrl(),
    lifecycleHooks: createBrowserLifecycleHooks(),
    userWebConnection,

    // ---- resolveSession ----
    resolveSession: async (kiloSessionId: KiloSessionId): Promise<ResolvedSession> => {
      // cliSessionsV2.get first. A failed query propagates — it must NOT
      // be silently classified as read-only.
      const session = await trpcClient.cliSessionsV2.get.query({ session_id: kiloSessionId });
      if (session.cloud_agent_session_id) {
        return {
          type: 'cloud-agent',
          kiloSessionId,
          cloudAgentSessionId: session.cloud_agent_session_id as CloudAgentSessionId,
        };
      }

      // same-org activeSessions.list
      const listInput = organizationId ? { organizationId } : { organizationId: null };
      const active = await trpcClient.activeSessions.list.query(
        listInput as { organizationId: string | null }
      );
      const activeSession = active.sessions.find(s => s.id === kiloSessionId);
      if (!activeSession) {
        return { type: 'read-only', kiloSessionId };
      }
      return {
        type: 'remote',
        kiloSessionId,
        ...(activeSession.capabilities ? { capabilities: activeSession.capabilities } : {}),
      };
    },

    // ---- getTicket ----
    getTicket: async (sessionId: CloudAgentSessionId): Promise<string> => {
      const token = getToken();
      const body: Record<string, string> = { cloudAgentSessionId: sessionId };
      if (organizationId) {
        body['organizationId'] = organizationId;
      }
      const response = await fetch(`${apiBaseUrl}/api/cloud-agent-next/sessions/stream-ticket`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const data = (await response.json()) as { ticket?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? 'Failed to get stream ticket');
      }
      if (!data.ticket) {
        throw new Error('Missing ticket in stream-ticket response');
      }
      return data.ticket;
    },

    // ---- fetchSnapshot ----
    fetchSnapshot: async (id: KiloSessionId) => {
      const [sessionData, messagesResult] = await Promise.all([
        trpcClient.cliSessionsV2.get.query({ session_id: id }),
        trpcClient.cliSessionsV2.getSessionMessages.query({ session_id: id }),
      ]);
      const snapshotInfo = messagesResult.info as Partial<SessionSnapshot['info']>;
      const parentID = snapshotInfo.parentID ?? sessionData.parent_session_id ?? undefined;
      return {
        info: {
          id: snapshotInfo.id ?? sessionData.session_id,
          ...(parentID != null ? { parentID } : {}),
          ...(snapshotInfo.model ? { model: snapshotInfo.model } : {}),
        },
        messages: messagesResult.messages as SessionSnapshot['messages'],
      } satisfies SessionSnapshot;
    },

    // ---- fetchSnapshotPage ----
    fetchSnapshotPage: (kiloSessionId, options) =>
      fetchExtensionSessionSnapshotPage(trpcClient, kiloSessionId, options),

    // ---- api (personal/org twins) ----
    api: {
      send: async input => {
        const baseInput = {
          cloudAgentSessionId: input.sessionId as string,
          payload: input.payload,
          autoCommit: true,
          messageId: input.messageId,
          ...(input.attachments ? { attachments: input.attachments } : {}),
        };
        if (organizationId) {
          await trpcClient.organizations.cloudAgentNext.sendMessage.mutate(
            { ...baseInput, organizationId },
            skipBatchOptions
          );
          return;
        }
        await trpcClient.cloudAgentNext.sendMessage.mutate(baseInput, skipBatchOptions);
      },
      interrupt: async payload => {
        if (organizationId) {
          await trpcClient.organizations.cloudAgentNext.interruptSession.mutate(
            { organizationId, sessionId: payload.sessionId },
            skipBatchOptions
          );
          return;
        }
        await trpcClient.cloudAgentNext.interruptSession.mutate(
          { sessionId: payload.sessionId },
          skipBatchOptions
        );
      },
      answer: async payload => {
        const input = {
          sessionId: payload.sessionId,
          questionId: payload.requestId,
          answers: payload.answers,
        };
        if (organizationId) {
          await trpcClient.organizations.cloudAgentNext.answerQuestion.mutate(
            { ...input, organizationId },
            skipBatchOptions
          );
          return;
        }
        await trpcClient.cloudAgentNext.answerQuestion.mutate(input, skipBatchOptions);
      },
      reject: async payload => {
        const input = {
          sessionId: payload.sessionId,
          questionId: payload.requestId,
        };
        if (organizationId) {
          await trpcClient.organizations.cloudAgentNext.rejectQuestion.mutate(
            { ...input, organizationId },
            skipBatchOptions
          );
          return;
        }
        await trpcClient.cloudAgentNext.rejectQuestion.mutate(input, skipBatchOptions);
      },
      respondToPermission: async payload => {
        const input = {
          sessionId: payload.sessionId,
          permissionId: payload.requestId,
          response: payload.response,
        };
        if (organizationId) {
          await trpcClient.organizations.cloudAgentNext.answerPermission.mutate(
            { ...input, organizationId },
            skipBatchOptions
          );
          return;
        }
        await trpcClient.cloudAgentNext.answerPermission.mutate(input, skipBatchOptions);
      },
    },

    // ---- prepare ----
    prepare: async input => {
      // Reject initialPayload with a clear v1 error before any tRPC call.
      if (input.initialPayload) {
        throw new Error(
          'initialPayload is not supported in extension v1 sessions. ' +
            'Start with a plain text prompt or /command instead.'
        );
      }
      const result = organizationId
        ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate(
            { ...input, organizationId } as never,
            skipBatchOptions
          )
        : await trpcClient.cloudAgentNext.prepareSession.mutate(input as never, skipBatchOptions);
      return {
        cloudAgentSessionId: result.cloudAgentSessionId as CloudAgentSessionId,
        kiloSessionId: result.kiloSessionId as KiloSessionId,
      };
    },

    // ---- initiate ----
    initiate: async input => {
      if (organizationId) {
        await trpcClient.organizations.cloudAgentNext.initiateFromPreparedSession.mutate(
          { cloudAgentSessionId: input.cloudAgentSessionId, organizationId },
          skipBatchOptions
        );
        return;
      }
      await trpcClient.cloudAgentNext.initiateFromPreparedSession.mutate(
        { cloudAgentSessionId: input.cloudAgentSessionId },
        skipBatchOptions
      );
    },

    // ---- fetchSession ----
    fetchSession: async (kiloSessionId: KiloSessionId): Promise<FetchedSessionData> => {
      const sessionResult = await fetchSessionWithNotFoundRetry(kiloSessionId, {
        query: id => trpcClient.cliSessionsV2.getWithRuntimeState.query({ session_id: id }),
      });
      const rs = sessionResult.runtimeState;
      return {
        kiloSessionId,
        cloudAgentSessionId: sessionResult.cloud_agent_session_id as CloudAgentSessionId | null,
        title: sessionResult.title,
        organizationId: sessionResult.organization_id,
        gitUrl: sessionResult.git_url,
        gitBranch: rs?.upstreamBranch ?? sessionResult.git_branch,
        mode: rs?.mode ?? null,
        model: rs?.model ?? null,
        variant: rs?.variant ?? null,
        repository: rs?.githubRepo ?? null,
        isInitiated: Boolean(rs?.initiatedAt),
        needsLegacyPrepare: Boolean(sessionResult.cloud_agent_session_id && !rs),
        isPreparingAsync: Boolean(rs && !rs.preparedAt),
        prompt: rs?.prompt ?? null,
        initialMessageId: rs?.initialMessageId ?? null,
        associatedPr: (sessionResult.associatedPr ?? null) as FetchedSessionData['associatedPr'],
        ...(rs?.runtimeAgents ? { runtimeAgents: rs.runtimeAgents } : {}),
        ...(sessionResult.total_cost_microdollars != null
          ? { totalCostMicrodollars: sessionResult.total_cost_microdollars as number }
          : {}),
        ...(sessionResult.created_on_platform != null
          ? { createdOnPlatform: sessionResult.created_on_platform as string }
          : {}),
      };
    },
  });
}
