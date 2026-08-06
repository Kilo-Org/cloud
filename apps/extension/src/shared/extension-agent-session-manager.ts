/* eslint-disable max-lines -- factory function assembles all SDK callbacks; splitting would scatter related transport logic across files */
import type { createTRPCClient } from '@trpc/client';
import { createBrowserLifecycleHooks, createSessionManager } from '@kilocode/cloud-agent-sdk';
import type {
  CloudAgentSessionId,
  FetchedSessionData,
  JotaiStore,
  KiloSessionId,
  KiloSdkMessageHistory,
  KiloSdkMessageHistoryPage,
  ResolvedSession,
  SessionManager,
  SessionSnapshot,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
  UserWebConnection,
} from '@kilocode/cloud-agent-sdk';
import type { MobileRouter, inferRouterOutputs } from '@kilocode/trpc/mobile';
import { rememberToolImage } from './agent-tool-images';
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Walk tRPC error shapes for a code string.
 * Extension-owned copy; mirrors `readFetchSessionErrorCode` from the mobile
 * session-manager so the extension has no dependency on mobile internals.
 */
export function readFetchSessionErrorCode(error: unknown): string | undefined {
  if (!isObject(error)) {
    return undefined;
  }
  const { data } = error;
  if (isObject(data)) {
    const { code } = data;
    if (typeof code === 'string') {
      return code;
    }
  }
  const { shape } = error;
  if (isObject(shape)) {
    const shapeData = shape['data'];
    if (isObject(shapeData)) {
      const { code } = shapeData;
      if (typeof code === 'string') {
        return code;
      }
    }
  }
  const top = error['code'];
  if (typeof top === 'string') {
    return top;
  }
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
      // eslint-disable-next-line no-await-in-loop -- intentional sequential retry loop
      return await options.query(kiloSessionId);
    } catch (error) {
      if (
        readFetchSessionErrorCode(error) !== 'NOT_FOUND' ||
        attempt >= SPAWNED_NOT_FOUND_MAX_ATTEMPTS
      ) {
        throw error;
      }
      attempt += 1;
      // eslint-disable-next-line no-await-in-loop -- intentional sequential retry delay
      await sleep(FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS);
    }
  }
}

async function defaultFetchSessionSleep(ms: number): Promise<void> {
  // eslint-disable-next-line promise/avoid-new -- setTimeout wrapper is the simplest cross-runtime sleep
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms);
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
    ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
  });

  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tRPC result shape is server-validated
  const history = result.history as KiloSdkMessageHistory | null;
  if (history === null) {
    return {
      info: { id: result.kiloSessionId },
      kind: 'success',
      messages: [],
      nextCursor: null,
      omittedItemCount: 0,
    };
  }

  if (isHistoryPage(history)) {
    return {
      info: { id: result.kiloSessionId },
      kind: 'success',
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- server-validated shape
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

interface CreateExtensionAgentSessionManagerOptions {
  store: JotaiStore;
  trpcClient: TrpcClient;
  /** Organization context. `null` = personal, a UUID = that organization. */
  organizationId: string | null;
  /** Token getter for auth headers. Returns the current Bearer token. */
  getToken: () => string | undefined;
  /** Kilo API base URL (injected so tests can provide a test origin). */
  apiBaseUrl: string;
  userWebConnection: UserWebConnection;
}

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
    // ---- api (personal/org twins) ----
    api: {
      answer: async payload => {
        const input = {
          answers: payload.answers,
          questionId: payload.requestId,
          sessionId: payload.sessionId,
        };
        if (organizationId !== null) {
          await trpcClient.organizations.cloudAgentNext.answerQuestion.mutate(
            { ...input, organizationId },
            skipBatchOptions
          );
          return;
        }
        await trpcClient.cloudAgentNext.answerQuestion.mutate(input, skipBatchOptions);
      },
      interrupt: async payload => {
        if (organizationId !== null) {
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
      reject: async payload => {
        const input = {
          questionId: payload.requestId,
          sessionId: payload.sessionId,
        };
        if (organizationId !== null) {
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
          permissionId: payload.requestId,
          response: payload.response,
          sessionId: payload.sessionId,
        };
        if (organizationId !== null) {
          await trpcClient.organizations.cloudAgentNext.answerPermission.mutate(
            { ...input, organizationId },
            skipBatchOptions
          );
          return;
        }
        await trpcClient.cloudAgentNext.answerPermission.mutate(input, skipBatchOptions);
      },
      send: async input => {
        const baseInput = {
          autoCommit: true,
          cloudAgentSessionId: input.sessionId as string,
          messageId: input.messageId,
          payload: input.payload,
          ...(input.attachments ? { attachments: input.attachments } : {}),
        };
        if (organizationId !== null) {
          await trpcClient.organizations.cloudAgentNext.sendMessage.mutate(
            { ...baseInput, organizationId },
            skipBatchOptions
          );
          return;
        }
        await trpcClient.cloudAgentNext.sendMessage.mutate(baseInput, skipBatchOptions);
      },
    },

    // ---- fetchSession ----
    fetchSession: async (kiloSessionId: KiloSessionId): Promise<FetchedSessionData> => {
      const sessionResult = await fetchSessionWithNotFoundRetry(kiloSessionId, {
        query: id => trpcClient.cliSessionsV2.getWithRuntimeState.query({ session_id: id }),
      });
      const rs = sessionResult.runtimeState;
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- tRPC output type differs from SDK type
        associatedPr: (sessionResult.associatedPr ?? null) as FetchedSessionData['associatedPr'],
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- server-validated branded string
        cloudAgentSessionId: sessionResult.cloud_agent_session_id as CloudAgentSessionId | null,
        ...(sessionResult.created_on_platform === null
          ? {}
          : { createdOnPlatform: sessionResult.created_on_platform }),
        gitBranch: rs?.upstreamBranch ?? sessionResult.git_branch,
        gitUrl: sessionResult.git_url,
        initialMessageId: rs?.initialMessageId ?? null,
        isInitiated: Boolean(rs?.initiatedAt),
        isPreparingAsync: Boolean(
          rs !== null &&
          (rs.preparedAt === undefined || rs.preparedAt === null || rs.preparedAt === 0)
        ),
        kiloSessionId,
        mode: rs?.mode ?? null,
        model: rs?.model ?? null,
        needsLegacyPrepare: Boolean(
          sessionResult.cloud_agent_session_id !== null &&
          sessionResult.cloud_agent_session_id !== '' &&
          !rs
        ),
        organizationId: sessionResult.organization_id,
        prompt: rs?.prompt ?? null,
        repository: rs?.githubRepo ?? null,
        ...(rs?.runtimeAgents === undefined ? {} : { runtimeAgents: rs.runtimeAgents }),
        title: sessionResult.title,
        ...(sessionResult.total_cost_microdollars === null
          ? {}
          : { totalCostMicrodollars: sessionResult.total_cost_microdollars }),
        variant: rs?.variant ?? null,
      };
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
          ...(parentID === undefined ? {} : { parentID }),
          ...(snapshotInfo.model ? { model: snapshotInfo.model } : {}),
        },
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- server-validated shape
        messages: messagesResult.messages as SessionSnapshot['messages'],
      } satisfies SessionSnapshot;
    },

    // ---- fetchSnapshotPage ----
    fetchSnapshotPage: (kiloSessionId, options) =>
      fetchExtensionSessionSnapshotPage(trpcClient, kiloSessionId, options),

    // ---- getTicket ----
    getTicket: async (sessionId: CloudAgentSessionId): Promise<string> => {
      const token = getToken();
      const body: Record<string, string> = { cloudAgentSessionId: sessionId };
      if (organizationId !== null) {
        body['organizationId'] = organizationId;
      }
      const response = await fetch(`${apiBaseUrl}/api/cloud-agent-next/sessions/stream-ticket`, {
        body: JSON.stringify(body),
        headers: {
          'Content-Type': 'application/json',
          ...(token === undefined || token === '' ? {} : { Authorization: `Bearer ${token}` }),
        },
        method: 'POST',
      });
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- fetch json is untyped
      const data = (await response.json()) as { ticket?: string; error?: string };
      if (!response.ok) {
        throw new Error(data.error ?? 'Failed to get stream ticket');
      }
      if (data.ticket === undefined) {
        throw new Error('Missing ticket in stream-ticket response');
      }
      return data.ticket;
    },

    // ---- initiate ----
    initiate: async input => {
      if (organizationId !== null) {
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

    lifecycleHooks: createBrowserLifecycleHooks(),

    // Tool attachment bytes are stripped before storage; keep the images here.
    onToolAttachment: rememberToolImage,

    // ---- prepare ----
    prepare: async input => {
      // Reject initialPayload with a clear v1 error before any tRPC call.
      if (input.initialPayload) {
        throw new Error(
          'initialPayload is not supported in extension v1 sessions. ' +
            'Start with a plain text prompt or /command instead.'
        );
      }
      const result =
        organizationId === null
          ? // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- SDK input differs from tRPC input
            await trpcClient.cloudAgentNext.prepareSession.mutate(input as never, skipBatchOptions)
          : // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- org endpoint adds organizationId
            await trpcClient.organizations.cloudAgentNext.prepareSession.mutate(
              // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- org mutation shape differs from SDK input type
              { ...input, organizationId } as never,
              skipBatchOptions
            );
      return {
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- server-validated branded string
        cloudAgentSessionId: result.cloudAgentSessionId as CloudAgentSessionId,
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- server-validated branded string
        kiloSessionId: result.kiloSessionId as KiloSessionId,
      };
    },

    // ---- resolveSession ----
    resolveSession: async (kiloSessionId: KiloSessionId): Promise<ResolvedSession> => {
      // CliSessionsV2.get first. A failed query propagates — it must NOT
      // Be silently classified as read-only.
      const session = await trpcClient.cliSessionsV2.get.query({ session_id: kiloSessionId });
      if (session.cloud_agent_session_id !== null && session.cloud_agent_session_id !== '') {
        return {
          // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- server-validated branded string
          cloudAgentSessionId: session.cloud_agent_session_id as CloudAgentSessionId,
          kiloSessionId,
          type: 'cloud-agent',
        };
      }

      // Same-org activeSessions.list
      const listInput = organizationId === null ? { organizationId: null } : { organizationId };
      const active = await trpcClient.activeSessions.list.query(
        listInput as { organizationId: string | null }
      );
      const activeSession = active.sessions.find(item => item.id === kiloSessionId);
      if (!activeSession) {
        return { kiloSessionId, type: 'read-only' };
      }
      return {
        kiloSessionId,
        type: 'remote',
        ...(activeSession.capabilities ? { capabilities: activeSession.capabilities } : {}),
      };
    },

    store,
    userWebConnection,
    websocketBaseUrl: getCloudAgentWsUrl(),
  });
}
