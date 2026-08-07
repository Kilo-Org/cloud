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
/**
 * Safety cap for the running-session history retry. The retry normally ends
 * when the persisted page carries messages or the session stops running (see
 * `ACTIVE_HISTORY_RECHECK_INTERVAL`); this bound only limits how long a
 * genuinely long-running turn can hold the initial history read open.
 */
const ACTIVE_HISTORY_MAX_RETRIES = 120;
/** Re-verify the session is still running every N retry reads. */
const ACTIVE_HISTORY_RECHECK_INTERVAL = 5;
/**
 * Extra reads after the session stops running. The CLI batches session-ingest
 * until the turn completes, and the ingest can land a moment after the
 * busy→idle status change, so keep polling briefly before applying the empty
 * page.
 */
const ACTIVE_HISTORY_END_GRACE_READS = 5;
/**
 * Bound for the not-yet-listed liveness probe. A running session can miss
 * its own row in `activeSessions.list` while the row registers or while the
 * active-sessions read model refreshes. A one-shot miss would latch an empty
 * page for a session that is actually running, so the gate re-checks liveness
 * for this many reads before treating the session as inactive.
 */
const ACTIVE_HISTORY_LIVENESS_GRACE_READS = 3;

const skipBatchOptions = { context: { skipBatch: true } } as const;

type TrpcClient = ReturnType<typeof createTRPCClient<MobileRouter>>;

/** Shape of the paged `getSessionMessagesPage` query result. */
type SessionMessagesPageResult = Awaited<
  ReturnType<TrpcClient['cliSessionsV2']['getSessionMessagesPage']['query']>
>;
/** Shape of the `activeSessions.list` query result used for liveness rechecks. */
type ActiveSessionsResult = Awaited<ReturnType<TrpcClient['activeSessions']['list']['query']>>;

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
 * True when the page carries no persisted SDK messages yet.
 *
 * Both a `null` history (the ingest DO has no session or message rows) and a
 * page with zero messages (a session row exists but no message has been
 * materialized) mean session-ingest persistence is still catching up while a
 * live CLI turn runs. Typed failure variants are not "empty" — they pass
 * through so the caller can surface retry semantics.
 */
function isPageWithoutPersistedMessages(history: KiloSdkMessageHistory | null): boolean {
  if (history === null) {
    return true;
  }
  return isHistoryPage(history) && history.messages.length === 0;
}

/**
 * Read the paged query's history in its server-validated shape. The tRPC
 * result carries typed failure variants alongside the page, so the shape is
 * narrowed at the transport boundary.
 */
function pageHistory(result: SessionMessagesPageResult): KiloSdkMessageHistory | null {
  // eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- tRPC result shape is server-validated
  return result.history as KiloSdkMessageHistory | null;
}

/**
 * Keep reading a running session's history page until it carries persisted
 * messages, the session stops running, or the safety bound is reached.
 */
async function readActiveHistoryWithRetry(
  initialResult: SessionMessagesPageResult,
  {
    fetchActiveSessions,
    isSessionWorking,
    queryPage,
  }: {
    queryPage: () => Promise<SessionMessagesPageResult>;
    fetchActiveSessions: () => Promise<ActiveSessionsResult>;
    isSessionWorking: (active: ActiveSessionsResult) => boolean;
  }
): Promise<SessionMessagesPageResult> {
  let result = initialResult;
  for (let attempt = 0; attempt < ACTIVE_HISTORY_MAX_RETRIES; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- retry persistence after a fixed delay
    await defaultFetchSessionSleep(FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS);
    // eslint-disable-next-line no-await-in-loop -- retries must observe ordered history
    result = await queryPage();
    if (!isPageWithoutPersistedMessages(pageHistory(result))) {
      return result;
    }
    if ((attempt + 1) % ACTIVE_HISTORY_RECHECK_INTERVAL === 0) {
      // eslint-disable-next-line no-await-in-loop -- ordered liveness recheck between retries
      const current = await fetchActiveSessions();
      if (!isSessionWorking(current)) {
        return readPageInEndGraceWindow(result, queryPage);
      }
    }
  }
  return result;
}

/**
 * Extra reads after the session stops running. The CLI batches session-ingest
 * until the turn completes, and the ingest can land a moment after the
 * busy→idle status change, so keep polling briefly before applying the empty
 * page.
 */
async function readPageInEndGraceWindow(
  initialResult: SessionMessagesPageResult,
  queryPage: () => Promise<SessionMessagesPageResult>
): Promise<SessionMessagesPageResult> {
  let result = initialResult;
  for (let grace = 0; grace < ACTIVE_HISTORY_END_GRACE_READS; grace += 1) {
    // eslint-disable-next-line no-await-in-loop -- bounded grace reads after turn end
    await defaultFetchSessionSleep(FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS);
    // eslint-disable-next-line no-await-in-loop -- bounded grace reads after turn end
    result = await queryPage();
    if (!isPageWithoutPersistedMessages(pageHistory(result))) {
      break;
    }
  }
  return result;
}

/**
 * Re-read liveness briefly when the initial page is empty and the session is
 * not confirmed working.
 *
 * A reopened running session can be listed idle or miss its active row while
 * the active-sessions read model refreshes or while the CLI batches
 * session-ingest until the turn completes. A one-shot idle or missing read
 * would latch an empty transcript that later persistence can never fill. This
 * bounded probe re-checks `activeSessions.list` for a fixed number of reads:
 * the session becomes busy → run the full active-history retry; the session
 * stays stably idle (or stays absent) for the whole window → resolve the empty
 * page. It re-reads liveness only; the history page is not re-read here, so an
 * inactive session still resolves its empty page without a page retry.
 */
async function readActiveHistoryWithLivenessGrace(
  initialResult: SessionMessagesPageResult,
  {
    fetchActiveSessions,
    isSessionWorking,
    queryPage,
  }: {
    fetchActiveSessions: () => Promise<ActiveSessionsResult>;
    isSessionWorking: (active: ActiveSessionsResult) => boolean;
    queryPage: () => Promise<SessionMessagesPageResult>;
  }
): Promise<SessionMessagesPageResult> {
  const result = initialResult;
  for (let attempt = 0; attempt < ACTIVE_HISTORY_LIVENESS_GRACE_READS; attempt += 1) {
    // eslint-disable-next-line no-await-in-loop -- bounded liveness re-reads before latching empty
    await defaultFetchSessionSleep(FETCH_SESSION_NOT_FOUND_RETRY_DELAY_MS);
    // eslint-disable-next-line no-await-in-loop -- bounded liveness re-reads before latching empty
    const current = await fetchActiveSessions();
    if (isSessionWorking(current)) {
      return readActiveHistoryWithRetry(result, {
        fetchActiveSessions,
        isSessionWorking,
        queryPage,
      });
    }
  }
  return result;
}

/**
 * Pin a replayed page to the active kilo session.
 *
 * The manager renders the root transcript only for messages whose
 * `sessionID` equals the adopted root session id, which `onSessionCreated`
 * seeds from the page's `info.id`. The session-ingest worker can persist
 * messages under a session id that differs from the one the extension opened
 * (the session-scoped page fetch is authoritative for the viewer), so without
 * this normalization every replayed message is filtered out and the reopened
 * live transcript renders empty. Rewriting the page id and each message and
 * part session id to the requested `kiloSessionId` keeps live and replayed
 * messages in the same root transcript while leaving the pagination cursor
 * and older-message behavior untouched.
 */
function pinPageToSession(
  page: SessionSnapshotPage & { kind: 'success' },
  kiloSessionId: KiloSessionId
): SessionSnapshotPage & { kind: 'success' } {
  return {
    ...page,
    info: { ...page.info, id: kiloSessionId },
    messages: page.messages.map(message => ({
      info: { ...message.info, sessionID: kiloSessionId },
      parts: message.parts.map(part => ({ ...part, sessionID: kiloSessionId })),
    })),
  };
}

/**
 * Adapt `cliSessionsV2.getSessionMessagesPage` result to the SDK's
 * `SessionSnapshotPageOutcome` union. Extension-owned; mirrors the mobile
 * `fetchMobileSessionSnapshotPage` adapter and pins the replayed page to the
 * requested `kiloSessionId` so the manager's root transcript filter keeps the
 * loaded history on screen.
 *
 * A running CLI session can read empty for a long stretch: the CLI batches
 * session-ingest until the turn completes, so the persisted page lags the
 * live turn. For such a session the bounded retry keeps reading until the
 * page carries messages or the session stops running, instead of latching an
 * empty transcript that later persistence can never fill.
 *
 * Both page outcomes forward the tRPC result's `watermarkEventId` (when the
 * server returned one) so the transport seeds its first WebSocket connect
 * with `fromId=0` and the ingest DO replays every stored event. That replay
 * is the safety net when a still-running session's empty page is latched:
 * the already-persisted user message still reaches the renderer.
 */
async function fetchExtensionSessionSnapshotPage(
  trpcClient: TrpcClient,
  kiloSessionId: KiloSessionId,
  options: { cursor?: string; organizationId: string | null }
): Promise<SessionSnapshotPageOutcome | null> {
  const queryPage = (): Promise<SessionMessagesPageResult> =>
    trpcClient.cliSessionsV2.getSessionMessagesPage.query({
      session_id: kiloSessionId,
      ...(options.cursor === undefined ? {} : { cursor: options.cursor }),
    });
  const fetchActiveSessions = (): Promise<ActiveSessionsResult> =>
    trpcClient.activeSessions.list.query({
      includeCloudAgentSessions: true,
      organizationId: options.organizationId,
    });
  const isSessionWorking = (active: ActiveSessionsResult): boolean =>
    active.sessions.some(session => session.id === kiloSessionId && session.status !== 'idle');

  let result = await queryPage();
  if (options.cursor === undefined && isPageWithoutPersistedMessages(pageHistory(result))) {
    /*
     * An empty first page can mean a freshly created idle session (empty by
     * definition, whose first prompt is sent immediately after this page
     * resolves and rendered via the live CLI echo) or a reopened running
     * session whose persisted page has not been materialized yet. The CLI
     * batches session-ingest until the turn completes and the active-sessions
     * read model can briefly list a starting session as idle or omit it, so a
     * single idle or missing liveness read must not latch the empty
     * transcript. Confirm liveness with a bounded probe: the session becomes
     * busy → keep reading until session-ingest persistence catches up; it
     * stays stably idle or absent → resolve the empty page without an
     * unbounded wait.
     */
    const active = await fetchActiveSessions();
    result = isSessionWorking(active)
      ? await readActiveHistoryWithRetry(result, {
          fetchActiveSessions,
          isSessionWorking,
          queryPage,
        })
      : await readActiveHistoryWithLivenessGrace(result, {
          fetchActiveSessions,
          isSessionWorking,
          queryPage,
        });
  }

  const history = pageHistory(result);
  /*
   * Forward the event-log watermark from the tRPC result. The transport
   * seeds its first WebSocket connect's `fromId` from the page watermark: a
   * present watermark makes the DO replay every stored event, closing the
   * gap between the page snapshot and the live stream when session-ingest
   * materialization lags a running turn. Dropping it here connects with
   * `replay=false`, and a reopened running session's already-persisted user
   * message never reaches the renderer even though the message API carries
   * it. Absent or null watermarks (fresh sessions, failed watermark read)
   * stay absent to keep `replay=false` for sessions with nothing to replay.
   */
  const watermark =
    result.watermarkEventId === null || result.watermarkEventId === undefined
      ? {}
      : { watermarkEventId: result.watermarkEventId };
  if (history === null) {
    return pinPageToSession(
      {
        info: { id: result.kiloSessionId },
        kind: 'success',
        messages: [],
        nextCursor: null,
        omittedItemCount: 0,
        ...watermark,
      },
      kiloSessionId
    );
  }

  if (isHistoryPage(history)) {
    return pinPageToSession(
      {
        info: { id: result.kiloSessionId },
        kind: 'success',
        // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- server-validated shape
        messages: history.messages as SessionSnapshotPage['messages'],
        nextCursor: history.nextCursor,
        omittedItemCount: history.omittedItemCount,
        ...watermark,
      },
      kiloSessionId
    );
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
      fetchExtensionSessionSnapshotPage(trpcClient, kiloSessionId, {
        ...options,
        organizationId,
      }),

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
