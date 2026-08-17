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
  type UserWebConnection,
} from '@kilocode/cloud-agent-sdk';
import { normalizeTransportPayload } from '@/components/agents/mobile-session-transport-payload';
import {
  formatSafeCloudAgentFailureDiagnostic,
  withCloudAgentDiagnostics,
} from '@/components/agents/mobile-session-diagnostics';
import { fetchMobileSessionSnapshotPage } from '@/components/agents/mobile-session-page-adapter';
import { API_BASE_URL, CLOUD_AGENT_WS_URL, WEB_BASE_URL } from '@/lib/config';
import { SPAWNED_NOT_FOUND_MAX_ATTEMPTS } from '@/lib/spawned-not-found-retry';
import { trpcClient } from '@/lib/trpc';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';
import { cacheToolAttachment } from '@/components/agents/tool-card-image-cache';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';

type SessionWithRuntimeState =
  inferRouterOutputs<MobileRouter>['cliSessionsV2']['getWithRuntimeState'];

/** Flat 1s cadence — same budget as the session-detail route's spawned retry. */
const FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS = 1000;

/**
 * tRPC error code from a thrown client error. Walks the same shapes the
 * session-detail route and blocking-card classifier use.
 */
export function readFetchSessionErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object') {
    return undefined;
  }
  const record = error as Record<string, unknown>;
  const data = record.data;
  if (data && typeof data === 'object') {
    const code = (data as Record<string, unknown>).code;
    if (typeof code === 'string') {
      return code;
    }
  }
  const shape = record.shape;
  if (shape && typeof shape === 'object') {
    const shapeData = (shape as Record<string, unknown>).data;
    if (shapeData && typeof shapeData === 'object') {
      const code = (shapeData as Record<string, unknown>).code;
      if (typeof code === 'string') {
        return code;
      }
    }
  }
  const top = record.code;
  if (typeof top === 'string') {
    return top;
  }
  return undefined;
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
  userWebConnection: UserWebConnection;
  organizationId?: string;
};

type AgentMode = 'code' | 'plan' | 'debug' | 'orchestrator' | 'ask';

const skipBatchOptions = { context: { skipBatch: true } };

export function createMobileAgentSessionManager({
  store,
  userWebConnection,
  organizationId,
}: Readonly<CreateMobileAgentSessionManagerOptions>): SessionManager {
  return createSessionManager({
    store,
    websocketBaseUrl: CLOUD_AGENT_WS_URL,
    websocketHeaders: { Origin: WEB_BASE_URL },
    lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
    userWebConnection,
    onToolAttachment: (partId, attachment) => {
      cacheToolAttachment(partId, attachment);
    },
    resolveSession: async (kiloSessionId: KiloSessionId): Promise<ResolvedSession> => {
      // Read-only is only ever returned once we have successful evidence the
      // session isn't cloud-agent or remote. A failed query here must
      // propagate so it lands in the retryable error state instead of being
      // silently misclassified as read-only.
      const session = await trpcClient.cliSessionsV2.get.query({ session_id: kiloSessionId });
      if (session.cloud_agent_session_id) {
        return {
          type: 'cloud-agent',
          kiloSessionId,
          cloudAgentSessionId: session.cloud_agent_session_id as CloudAgentSessionId,
        };
      }
      const active = await trpcClient.activeSessions.list.query();
      const activeSession = active.sessions.find(s => s.id === kiloSessionId);
      if (!activeSession) {
        return { type: 'read-only', kiloSessionId };
      }
      // Surface the owning CLI's per-session capabilities so the initial
      // `supportsAttachments` gate reflects whatever the mobile adapter
      // observed at resolution time. Heartbeat upgrades / downgrades
      // arrive later via `onTransportCapabilitiesChange` from the
      // cli-live-transport; the seed here just covers the window before
      // the first heartbeat lands.
      return {
        type: 'remote',
        kiloSessionId,
        ...(activeSession.capabilities ? { capabilities: activeSession.capabilities } : {}),
      };
    },
    getTicket: async (sessionId: CloudAgentSessionId): Promise<string> => {
      const ticket = await withCloudAgentDiagnostics('getTicket', organizationId, async () => {
        const token = await getAuthTokenForRequest();
        const body: Record<string, string> = { cloudAgentSessionId: sessionId };
        if (organizationId) {
          body.organizationId = organizationId;
        }
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
        const data = (await response.json()) as { ticket?: string; error?: string };
        if (!response.ok) {
          throw new Error(data.error ?? 'Failed to get stream ticket');
        }
        if (!data.ticket) {
          throw new Error('Missing ticket in stream-ticket response');
        }
        return data.ticket;
      });
      return ticket;
    },
    fetchSnapshot: async (id: KiloSessionId) => {
      const [sessionData, messagesResult] = await Promise.all([
        trpcClient.cliSessionsV2.get.query({ session_id: id }),
        trpcClient.cliSessionsV2.getSessionMessages.query({ session_id: id }),
      ]);
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
    fetchSnapshotPage: fetchMobileSessionSnapshotPage,
    api: {
      send: async input => {
        await withCloudAgentDiagnostics('send', organizationId, async () => {
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
        });
      },
      interrupt: async payload => {
        await withCloudAgentDiagnostics('interrupt', organizationId, async () => {
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
        });
      },
      answer: async payload => {
        await withCloudAgentDiagnostics('answer', organizationId, async () => {
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
        });
      },
      reject: async payload => {
        await withCloudAgentDiagnostics('reject', organizationId, async () => {
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
        });
      },
      respondToPermission: async payload => {
        await withCloudAgentDiagnostics('permission', organizationId, async () => {
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
        });
      },
    },
    prepare: async input => {
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
              skipBatchOptions
            )
          : await trpcClient.cloudAgentNext.prepareSession.mutate(castInput, skipBatchOptions);
        return {
          cloudAgentSessionId: result.cloudAgentSessionId as CloudAgentSessionId,
          kiloSessionId: result.kiloSessionId as KiloSessionId,
        };
      });
      return prepared;
    },
    initiate: async input => {
      await withCloudAgentDiagnostics('initiate', organizationId, async () => {
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
      });
    },
    onSendFailed: (_messageText, displayMessage, error) => {
      toast.error(
        formatSafeCloudAgentFailureDiagnostic('send', error, organizationId) ??
          displayMessage ??
          'Failed to send message. Please try again.'
      );
    },
    fetchSession: async (kiloSessionId: KiloSessionId): Promise<FetchedSessionData> => {
      const sessionResult = await fetchSessionWithNotFoundRetry(kiloSessionId);
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
}
