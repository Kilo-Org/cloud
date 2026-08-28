/* eslint-disable max-lines -- fetchSession NOT_FOUND retry helpers stay with the manager (M1). */
import { toast } from 'sonner-native';
import {
  type CloudAgentSessionId,
  createSessionManager,
  type FetchedSessionData,
  type JotaiStore,
  type KiloSessionId,
  type ResolvedSession,
  type SessionManager,
  type SessionSnapshot,
} from '@kilocode/cloud-agent-sdk';
import { normalizeTransportPayload } from '@/components/agents/mobile-session-transport-payload';
import {
  formatSafeCloudAgentFailureDiagnostic,
  withCloudAgentDiagnostics,
} from '@/components/agents/mobile-session-diagnostics';
import { fetchMobileSessionSnapshotPage } from '@/components/agents/mobile-session-page-adapter';
import { type AgentMode } from '@/components/agents/mode-normalize';
import { API_BASE_URL, CLOUD_AGENT_WS_URL, WEB_BASE_URL } from '@/lib/config';
import { SPAWNED_NOT_FOUND_MAX_ATTEMPTS } from '@/lib/spawned-not-found-retry';
import { trpcClient } from '@/lib/trpc';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';
import { cacheToolAttachment } from '@/components/agents/tool-card-image-cache';
import { cacheFilePart } from '@/components/agents/file-part-cache';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import * as z from 'zod';
import { i18n } from '@/i18n';
import { subscribeAuthenticatedOwner } from '@/lib/context-scope';
import {
  assertMobileActionAdmission,
  assertTransportOwner,
  captureMobileActionAdmission,
  getLocalAccessDenial,
  isTransportOwner,
  type MobileActionAdmission,
  type MobileUserWebConnection,
} from '@/lib/local-access-transport';
import { LocalAccessDeniedError } from '@/lib/local-access';

type SessionWithRuntimeState =
  inferRouterOutputs<MobileRouter>['cliSessionsV2']['getWithRuntimeState'];

/** Flat 1s cadence — same budget as the session-detail route's spawned retry. */
const FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS = 1000;

/**
 * tRPC error code from a thrown client error. Walks the same shapes the
 * session-detail route and blocking-card classifier use.
 */
export function readFetchSessionErrorCode(error: unknown): string | undefined {
  return readTrpcErrorField(error, 'code');
}

/**
 * tRPC codes transient enough to keep the same cloud-prepare `operationKey`
 * across a retry. Any other typed code is a terminal rejection and rotates it.
 */
const CLOUD_PREPARE_TRANSIENT_CODES = new Set([
  'INTERNAL_SERVER_ERROR',
  'BAD_GATEWAY',
  'SERVICE_UNAVAILABLE',
  'GATEWAY_TIMEOUT',
  'TIMEOUT',
  'TOO_MANY_REQUESTS',
]);

/** Stable message the ledger returns on a same-key in-flight duplicate (plan P1-A-08b). */
const CLOUD_PREPARE_IN_PROGRESS_MESSAGE = 'creation_in_progress';

/**
 * Wire contract for the cloud-agent stream-ticket endpoint. `expiresAt` is the
 * Unix-epoch number `signStreamTicket` returns. All fields are optional here;
 * the required-field check below rejects an otherwise-valid object missing
 * `ticket` or `expiresAt`.
 */
export const StreamTicketResponseSchema = z.object({
  ticket: z.string().optional(),
  expiresAt: z.number().optional(),
  error: z.string().optional(),
});

/**
 * True when a `prepareSession` failure may be retried with the SAME
 * `operationKey`: `creation_in_progress`, a transient 5xx, or a codeless
 * transport failure (the ledger reconciles the ambiguous prior attempt).
 */
export function isCloudPrepareRetryableError(error: unknown): boolean {
  const code = readFetchSessionErrorCode(error);
  if (code === undefined) {
    return true;
  }
  if (code === 'CONFLICT') {
    return error instanceof Error && error.message === CLOUD_PREPARE_IN_PROGRESS_MESSAGE;
  }
  return CLOUD_PREPARE_TRANSIENT_CODES.has(code);
}

/* eslint-disable @typescript-eslint/promise-function-async, require-await -- thin tRPC passthrough */
async function defaultFetchSessionQuery(
  sessionId: KiloSessionId
): Promise<SessionWithRuntimeState> {
  return trpcClient.cliSessionsV2.getWithRuntimeState.query({
    session_id: sessionId,
  });
}
/* eslint-enable @typescript-eslint/promise-function-async, require-await */

async function defaultFetchSessionSleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

/**
 * Query `cliSessionsV2.getWithRuntimeState` with a NOT_FOUND retry so a
 * just-spawned or just-`/new`ed session can open on org routes (where the
 * route-level `cliSessionsV2.get` query is disabled). Personal routes get
 * the same budget harmlessly. Non-NOT_FOUND errors fail immediately.
 *
 * `query` and `sleep` are injectable for unit tests.
 */
export async function fetchSessionWithNotFoundRetry(
  kiloSessionId: KiloSessionId,
  options?: {
    query?: (sessionId: KiloSessionId) => Promise<SessionWithRuntimeState>;
    sleep?: (ms: number) => Promise<void>;
    maxAttempts?: number;
    delayMs?: number;
  }
): Promise<SessionWithRuntimeState> {
  const query = options?.query ?? defaultFetchSessionQuery;
  const sleep = options?.sleep ?? defaultFetchSessionSleep;
  const maxAttempts = options?.maxAttempts ?? SPAWNED_NOT_FOUND_MAX_ATTEMPTS;
  const delayMs = options?.delayMs ?? FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS;

  let attempt = 0;
  for (;;) {
    try {
      // Sequential backoff — each attempt waits for the previous failure.
      // eslint-disable-next-line no-await-in-loop -- NOT_FOUND retry cadence
      return await query(kiloSessionId);
    } catch (error) {
      if (readFetchSessionErrorCode(error) !== 'NOT_FOUND' || attempt >= maxAttempts) {
        throw error;
      }
      attempt += 1;
      // eslint-disable-next-line no-await-in-loop -- flat 1s delay between retries
      await sleep(delayMs);
    }
  }
}

type CreateMobileAgentSessionManagerOptions = {
  store: JotaiStore;
  userWebConnection: MobileUserWebConnection;
  organizationId?: string;
};

export function createMobileAgentSessionManager({
  store,
  userWebConnection,
  organizationId,
}: Readonly<CreateMobileAgentSessionManagerOptions>): SessionManager {
  // This boundary requires the provider's immutable socket owner, not a fresh global account.
  const owner = userWebConnection.owner;
  const ownerOptions = { context: { localAccessOwner: owner } };
  const preparations = new Map<CloudAgentSessionId, MobileActionAdmission[]>();
  const captureOptions = (
    admission = captureMobileActionAdmission(owner, organizationId ?? null)
  ) => {
    assertMobileActionAdmission(admission);
    return {
      context: { skipBatch: true, localAccessOwner: owner, localAccessAdmission: admission },
    };
  };
  const manager = createSessionManager({
    store,
    websocketBaseUrl: CLOUD_AGENT_WS_URL,
    websocketHeaders: { Origin: WEB_BASE_URL },
    lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
    userWebConnection,
    onToolAttachment: (partId, attachment) => {
      if (isTransportOwner(owner)) {
        cacheToolAttachment(partId, attachment);
      }
    },
    onFilePart: (partId, file) => {
      if (isTransportOwner(owner)) {
        cacheFilePart(partId, file);
      }
    },
    resolveSession: async (kiloSessionId: KiloSessionId): Promise<ResolvedSession> => {
      // Preserve loading failures; only successful evidence can classify a session as read-only.
      assertTransportOwner(owner);
      const session = await trpcClient.cliSessionsV2.get.query(
        { session_id: kiloSessionId },
        ownerOptions
      );
      assertTransportOwner(owner);
      userWebConnection.setSessionScope(kiloSessionId, session.organization_id);
      if (session.cloud_agent_session_id) {
        return {
          type: 'cloud-agent',
          kiloSessionId,
          cloudAgentSessionId: session.cloud_agent_session_id as CloudAgentSessionId,
        };
      }
      const active = await trpcClient.activeSessions.list.query(undefined, ownerOptions);
      assertTransportOwner(owner);
      const activeSession = active.sessions.find(s => s.id === kiloSessionId);
      if (!activeSession) {
        return { type: 'read-only', kiloSessionId };
      }
      // Heartbeats can replace this initial capability seed without changing the loading contract.
      return {
        type: 'remote',
        kiloSessionId,
        ...(activeSession.capabilities ? { capabilities: activeSession.capabilities } : {}),
      };
    },
    getTicket: async (
      sessionId: CloudAgentSessionId
    ): Promise<{ ticket: string; expiresAt: number }> => {
      const result = await withCloudAgentDiagnostics('getTicket', organizationId, async () => {
        assertTransportOwner(owner);
        const token = await getAuthTokenForRequest();
        assertTransportOwner(owner);
        const body = {
          cloudAgentSessionId: sessionId,
          ...(organizationId ? { organizationId } : {}),
        };
        const response = await fetch(
          `${API_BASE_URL}/api/cloud-agent-next/sessions/stream-ticket`,
          {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              ...(token ? { Authorization: `Bearer ${token}` } : {}),
            },
            body: JSON.stringify(body),
          }
        );
        const data = StreamTicketResponseSchema.parse(await response.json());
        assertTransportOwner(owner);
        if (!response.ok) {
          throw new Error(data.error ?? 'Failed to get stream ticket');
        }
        if (!data.ticket) {
          throw new Error('Missing ticket in stream-ticket response');
        }
        if (data.expiresAt === undefined) {
          throw new Error('Missing expiresAt in stream-ticket response');
        }
        return { ticket: data.ticket, expiresAt: data.expiresAt };
      });
      return result;
    },
    fetchSnapshot: async (id: KiloSessionId) => {
      assertTransportOwner(owner);
      const [sessionData, messagesResult] = await Promise.all([
        trpcClient.cliSessionsV2.get.query({ session_id: id }, ownerOptions),
        trpcClient.cliSessionsV2.getSessionMessages.query({ session_id: id }, ownerOptions),
      ]);
      assertTransportOwner(owner);
      const snapshotInfo = messagesResult.info as Partial<SessionSnapshot['info']>;
      return {
        info: {
          id: snapshotInfo.id ?? sessionData.session_id,
          parentID: snapshotInfo.parentID ?? sessionData.parent_session_id ?? undefined,
          ...(snapshotInfo.model ? { model: snapshotInfo.model } : {}),
        },
        messages: messagesResult.messages as SessionSnapshot['messages'],
      };
    },
    fetchSnapshotPage: async (id, options) => {
      assertTransportOwner(owner);
      const page = await fetchMobileSessionSnapshotPage(id, options);
      assertTransportOwner(owner);
      return page;
    },
    api: {
      send: async input => {
        const options = captureOptions();
        await withCloudAgentDiagnostics('send', organizationId, async () => {
          const baseInput = {
            cloudAgentSessionId: input.sessionId as string,
            payload: input.payload,
            messageId: input.messageId,
            ...(input.attachments ? { attachments: input.attachments } : {}),
          };
          if (organizationId) {
            await trpcClient.organizations.cloudAgentNext.sendMessage.mutate(
              { ...baseInput, organizationId },
              options
            );
            return;
          }
          await trpcClient.cloudAgentNext.sendMessage.mutate(baseInput, options);
        });
      },
      interrupt: async payload => {
        const options = captureOptions();
        await withCloudAgentDiagnostics('interrupt', organizationId, async () => {
          if (organizationId) {
            await trpcClient.organizations.cloudAgentNext.interruptSession.mutate(
              { organizationId, sessionId: payload.sessionId },
              options
            );
            return;
          }
          await trpcClient.cloudAgentNext.interruptSession.mutate(
            { sessionId: payload.sessionId },
            options
          );
        });
      },
      answer: async payload => {
        const options = captureOptions();
        await withCloudAgentDiagnostics('answer', organizationId, async () => {
          const input = {
            sessionId: payload.sessionId,
            questionId: payload.requestId,
            answers: payload.answers,
          };
          if (organizationId) {
            await trpcClient.organizations.cloudAgentNext.answerQuestion.mutate(
              { ...input, organizationId },
              options
            );
            return;
          }
          await trpcClient.cloudAgentNext.answerQuestion.mutate(input, options);
        });
      },
      reject: async payload => {
        const options = captureOptions();
        await withCloudAgentDiagnostics('reject', organizationId, async () => {
          const input = {
            sessionId: payload.sessionId,
            questionId: payload.requestId,
          };
          if (organizationId) {
            await trpcClient.organizations.cloudAgentNext.rejectQuestion.mutate(
              { ...input, organizationId },
              options
            );
            return;
          }
          await trpcClient.cloudAgentNext.rejectQuestion.mutate(input, options);
        });
      },
      respondToPermission: async payload => {
        const options = captureOptions();
        await withCloudAgentDiagnostics('permission', organizationId, async () => {
          const input = {
            sessionId: payload.sessionId,
            permissionId: payload.requestId,
            response: payload.response,
          };
          if (organizationId) {
            await trpcClient.organizations.cloudAgentNext.answerPermission.mutate(
              { ...input, organizationId },
              options
            );
            return;
          }
          await trpcClient.cloudAgentNext.answerPermission.mutate(input, options);
        });
      },
    },
    prepare: async input => {
      const admission = captureMobileActionAdmission(owner, organizationId ?? null);
      const options = captureOptions(admission);
      const prepared = await withCloudAgentDiagnostics('prepare', organizationId, async () => {
        const castInput = {
          ...input,
          initialPayload: input.initialPayload
            ? normalizeTransportPayload(input.initialPayload)
            : undefined,
          mode: input.mode as AgentMode,
        };
        const result = organizationId
          ? await trpcClient.organizations.cloudAgentNext.prepareSession.mutate(
              { ...castInput, organizationId },
              options
            )
          : await trpcClient.cloudAgentNext.prepareSession.mutate(castInput, options);
        return {
          cloudAgentSessionId: result.cloudAgentSessionId as CloudAgentSessionId,
          kiloSessionId: result.kiloSessionId as KiloSessionId,
        };
      });
      assertTransportOwner(owner);
      // SDK createAndStart initiates immediately after prepare resolves. Keep that resolution order
      // when idempotent prepares share a session ID; a later operation must not replace an old lease.
      const pending = preparations.get(prepared.cloudAgentSessionId) ?? [];
      pending.push(admission);
      preparations.set(prepared.cloudAgentSessionId, pending);
      return prepared;
    },
    initiate: async input => {
      const pending = preparations.get(input.cloudAgentSessionId);
      const admission = pending?.shift();
      if (pending?.length === 0) {
        preparations.delete(input.cloudAgentSessionId);
      }
      if (!admission) {
        throw new LocalAccessDeniedError('stale');
      }
      const options = captureOptions(admission);
      await withCloudAgentDiagnostics('initiate', organizationId, async () => {
        if (organizationId) {
          await trpcClient.organizations.cloudAgentNext.initiateFromPreparedSession.mutate(
            { cloudAgentSessionId: input.cloudAgentSessionId, organizationId },
            options
          );
          return;
        }
        await trpcClient.cloudAgentNext.initiateFromPreparedSession.mutate(
          { cloudAgentSessionId: input.cloudAgentSessionId },
          options
        );
      });
    },
    onSendFailed: (_messageText, displayMessage, error) => {
      if (!isTransportOwner(owner)) {
        return;
      }
      const denial = getLocalAccessDenial(error);
      if (denial) {
        throw denial;
      }
      toast.error(
        formatSafeCloudAgentFailureDiagnostic('send', error, organizationId) ??
          displayMessage ??
          i18n.t('agentChat.messageFailure.sendFailed')
      );
    },
    fetchSession: async (kiloSessionId: KiloSessionId): Promise<FetchedSessionData> => {
      assertTransportOwner(owner);
      const sessionResult = await fetchSessionWithNotFoundRetry(kiloSessionId, {
        query: async sessionId => {
          const result = await trpcClient.cliSessionsV2.getWithRuntimeState.query(
            { session_id: sessionId },
            ownerOptions
          );
          return result;
        },
      });
      assertTransportOwner(owner);
      userWebConnection.setSessionScope(kiloSessionId, sessionResult.organization_id);
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
        associatedPr: sessionResult.associatedPr,
        runtimeAgents: rs?.runtimeAgents,
        totalCostMicrodollars: sessionResult.total_cost_microdollars,
        createdOnPlatform: sessionResult.created_on_platform,
      };
    },
  });
  const unsubscribeOwner = subscribeAuthenticatedOwner(() => {
    if (!isTransportOwner(owner)) {
      preparations.clear();
      manager.destroy();
      unsubscribeOwner();
    }
  });
  return {
    ...manager,
    destroy() {
      unsubscribeOwner();
      preparations.clear();
      manager.destroy();
    },
  };
}
