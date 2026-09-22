/* eslint-disable max-lines -- fetchSession NOT_FOUND retry helpers stay with the manager (M1). */
import { toast } from 'sonner-native';
import {
  type CloudAgentSessionId,
  createSessionManager,
  type FetchedSessionData,
  type JotaiStore,
  type KiloSessionId,
  projectSessionGoal,
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
import { RequestDeadlineError } from '@kilocode/event-service';
import { fetchMobileSessionSnapshotPage } from '@/components/agents/mobile-session-page-adapter';
import { type AgentMode } from '@/components/agents/mode-normalize';
import { CLOUD_AGENT_WS_URL, WEB_BASE_URL } from '@/lib/config';
import {
  fetchCloudAgentStreamTicket,
  StreamTicketResponseSchema,
} from '@/lib/cloud-agent-stream-ticket';
import { SPAWNED_NOT_FOUND_MAX_ATTEMPTS } from '@/lib/spawned-not-found-retry';
import { trpcClient } from '@/lib/trpc';
import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';
import { answerSessionPermission } from '@/lib/glanceable/approve-ask';
import { cacheToolAttachment } from '@/components/agents/tool-card-image-cache';
import { cacheFilePart } from '@/components/agents/file-part-cache';
import {
  persistResolvedDeliveryFailure,
  readResolvedDeliveryFailures,
} from '@/lib/persist/resolved-delivery-failures';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { i18n } from '@/i18n';

export { StreamTicketResponseSchema };

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
 * True when the failure is the client control-plane deadline firing — the
 * request never got an answer, so the open is stalled rather than failed.
 * tRPC wraps the thrown reason in a `TRPCClientError` whose `cause` chain
 * carries it, so the walk is bounded against malformed chains.
 */
export function isStalledTransportError(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current instanceof Error; depth += 1) {
    if (current instanceof RequestDeadlineError) {
      return true;
    }
    current = (current as Error & { cause?: unknown }).cause;
  }
  return false;
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

const CANCEL_QUEUED_UPGRADE_REQUIRED_CODE = 'CLI_UPGRADE_REQUIRED';

export function isCancelQueuedUpgradeRequired(error: unknown): boolean {
  return readFetchSessionErrorCode(error) === CANCEL_QUEUED_UPGRADE_REQUIRED_CODE;
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
  /**
   * The authenticated owner the resolved-delivery-failure memory is scoped to.
   * The manager's own persisted transcript cache is gone, so this scope is only
   * read by that memory; an absent owner skips it rather than writing to a
   * shared anonymous scope.
   */
  userId?: string;
};

const skipBatchOptions = { context: { skipBatch: true } };

export function createMobileAgentSessionManager({
  store,
  userWebConnection,
  organizationId: initialOrganizationId,
  userId,
}: Readonly<CreateMobileAgentSessionManagerOptions>): SessionManager {
  // The route resolves the session's organization from its metadata read, but
  // that read can be paused (offline) or stalled when the route mounts the
  // session on its persisted transcript, so the scope handed in may still be
  // absent. `fetchSession` learns the same organization a beat later; every
  // request closure below reads this binding at call time, so a scope resolved
  // after mount applies without recreating the manager — and without the route
  // re-keying the provider, which would remount the transcript and drop the
  // composer draft under it.
  let organizationId = initialOrganizationId;
  // Last successful `fetchSession` metadata, memoized so `resolveSession` can
  // read `cloud_agent_session_id` without a duplicate serial
  // `cliSessionsV2.get`. It is only consulted when the id matches; any other
  // resolve keeps the defensive query.
  let fetchedMetadata: {
    sessionId: KiloSessionId;
    cloudAgentSessionId: CloudAgentSessionId | null;
  } | null = null;
  // The auth epoch this manager was created under. A resolved-delivery-failure
  // write captured before a sign-out/sign-in must not land in the previous
  // account's scope, so the write path re-checks this epoch. An empty owner
  // skips the memory entirely.
  const resolvedDeliveryOwner = { userId: userId ?? '', authEpoch: currentAuthEpoch() };
  return createSessionManager({
    store,
    websocketBaseUrl: CLOUD_AGENT_WS_URL,
    websocketHeaders: { Origin: WEB_BASE_URL },
    lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
    userWebConnection,
    // Durable memory of retried delivery failures, so the DO's stored-event
    // replay on the next open cannot restore a footer the retry cleared.
    // eslint-disable-next-line @typescript-eslint/promise-function-async -- passthrough returns the promise directly
    readResolvedDeliveryFailures: (id: KiloSessionId) =>
      readResolvedDeliveryFailures(resolvedDeliveryOwner.userId, id),
    persistResolvedDeliveryFailure: (id: KiloSessionId, messageId: string) => {
      void persistResolvedDeliveryFailure(resolvedDeliveryOwner, id, messageId);
    },
    // A tRPC call whose client control-plane deadline expired never got an
    // answer: the open is stalled, not failed. The manager keeps the skeleton
    // (then the slow-load state with Retry) instead of a premature error
    // screen. Unwrapped from the TRPCClientError tRPC layers over it.
    isStalledTransportError,
    onToolAttachment: (partId, attachment) => {
      cacheToolAttachment(partId, attachment);
    },
    onFilePart: (partId, file) => {
      cacheFilePart(partId, file);
    },
    resolveSession: async (kiloSessionId: KiloSessionId): Promise<ResolvedSession> => {
      // `fetchSession` already read this row through `getWithRuntimeState`, so
      // reuse its cloud-agent id instead of a duplicate serial
      // `cliSessionsV2.get`. Any other resolve (no matching memo) keeps the
      // query: read-only is only ever returned once we have successful
      // evidence the session isn't cloud-agent or remote, and a failed query
      // here must propagate so it lands in the retryable error state instead
      // of being silently misclassified as read-only.
      const memo = fetchedMetadata;
      let cloudAgentSessionId: CloudAgentSessionId | null = null;
      if (memo?.sessionId === kiloSessionId) {
        cloudAgentSessionId = memo.cloudAgentSessionId;
      } else {
        const session = await trpcClient.cliSessionsV2.get.query({ session_id: kiloSessionId });
        cloudAgentSessionId = session.cloud_agent_session_id as CloudAgentSessionId | null;
      }
      if (cloudAgentSessionId) {
        return {
          type: 'cloud-agent',
          kiloSessionId,
          cloudAgentSessionId,
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
    getTicket: async (
      sessionId: CloudAgentSessionId
    ): Promise<{ ticket: string; expiresAt: number }> => {
      const result = await withCloudAgentDiagnostics('getTicket', organizationId, async () => {
        const ticket = await fetchCloudAgentStreamTicket(sessionId, organizationId);
        return ticket;
      });
      return result;
    },
    fetchSnapshot: async (id: KiloSessionId) => {
      const [sessionData, messagesResult] = await Promise.all([
        trpcClient.cliSessionsV2.get.query({ session_id: id }),
        trpcClient.cliSessionsV2.getSessionMessages.query({ session_id: id }),
      ]);
      const snapshotInfo = messagesResult.info as Partial<SessionSnapshot['info']> & {
        metadata?: unknown;
      };
      // The goal lives in the session metadata; project it into `info` so the
      // fixed goal section survives a snapshot replay (which would otherwise
      // clobber the goal carried by the live session state).
      const goal = projectSessionGoal(snapshotInfo.metadata);
      return {
        info: {
          id: snapshotInfo.id ?? sessionData.session_id,
          parentID: snapshotInfo.parentID ?? sessionData.parent_session_id ?? undefined,
          ...(snapshotInfo.model ? { model: snapshotInfo.model } : {}),
          ...(goal === undefined ? {} : { goal }),
        },
        messages: messagesResult.messages as SessionSnapshot['messages'],
      };
    },
    fetchSnapshotPage: async (id: KiloSessionId, options: { cursor?: string }) => {
      const outcome = await fetchMobileSessionSnapshotPage(id, options);
      return outcome;
    },
    api: {
      send: async input => {
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
              skipBatchOptions
            );
            return;
          }
          await trpcClient.cloudAgentNext.sendMessage.mutate(baseInput, skipBatchOptions);
        });
      },
      /* eslint-disable @typescript-eslint/promise-function-async, require-await -- thin tRPC passthrough */
      cancelQueuedMessage: async input =>
        withCloudAgentDiagnostics('cancelQueuedMessage', organizationId, async () => {
          if (organizationId) {
            return trpcClient.organizations.cloudAgentNext.cancelQueuedMessage.mutate(
              { sessionId: input.sessionId, messageId: input.messageId, organizationId },
              skipBatchOptions
            );
          }
          return trpcClient.cloudAgentNext.cancelQueuedMessage.mutate(
            { sessionId: input.sessionId, messageId: input.messageId },
            skipBatchOptions
          );
        }),
      /* eslint-enable @typescript-eslint/promise-function-async, require-await */
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
          // The one answer path: the activity action runs the same body
          // (`runGlanceableApprove` -> `answerSessionPermission`).
          await answerSessionPermission({
            cloudAgentSessionId: payload.sessionId,
            organizationId,
            requestId: payload.requestId,
            response: payload.response,
          });
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
          i18n.t('agentChat.messageFailure.sendFailed')
      );
    },
    fetchSession: async (kiloSessionId: KiloSessionId): Promise<FetchedSessionData> => {
      const sessionResult = await fetchSessionWithNotFoundRetry(kiloSessionId);
      // The route mounted before its metadata read could settle (offline or
      // stalled): adopt the organization this read resolves so org-scoped
      // requests carry it. An explicit route scope always wins.
      organizationId ??= sessionResult.organization_id ?? undefined;
      const cloudAgentSessionId =
        sessionResult.cloud_agent_session_id as CloudAgentSessionId | null;
      // Memoize the metadata `resolveSession` needs so it never re-reads the row.
      fetchedMetadata = { sessionId: kiloSessionId, cloudAgentSessionId };
      const rs = sessionResult.runtimeState;
      return {
        kiloSessionId,
        cloudAgentSessionId,
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
