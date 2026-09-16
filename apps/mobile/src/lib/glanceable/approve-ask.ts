import {
  type ConnectionConfig,
  createConnection,
  type KiloSessionId,
} from '@kilocode/cloud-agent-sdk';
import { type GlanceableSessionRow } from '@kilocode/app-shared/glanceable-agents-snapshot';
import { z } from 'zod';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { fetchCloudAgentStreamTicket } from '@/lib/cloud-agent-stream-ticket';
import { CLOUD_AGENT_WS_URL, WEB_BASE_URL } from '@/lib/config';
import { trpcClient } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';

import { createGlanceablePublisher } from './create-publisher';
import { readWaitingAsk, recordWaitingAsk } from './waiting-ask';

/**
 * The one answer path. The in-app permission card answers through
 * `answerSessionPermission` (via the session manager); an activity action runs
 * `runGlanceableApprove`, which resolves the recorded ask, answers through the
 * same body, and republishes the tray with `refreshGlanceableSnapshot`.
 *
 * Nothing here touches React or a component: the background contexts (Android
 * headless worker, iOS intent) run it with the app closed.
 */

/** The three answers the in-app permission card sends. */
type PermissionResponse = 'once' | 'always' | 'reject';

/** What an activity surface does with the outcome of an approve attempt. */
export type GlanceableApproveResult =
  | { kind: 'approved' }
  | { kind: 'retryable' }
  | { kind: 'gone' }
  | { kind: 'none' };

/**
 * The session the ask names has no cloud-agent (control-plane) permission to
 * answer. Carries the tRPC-shaped `data.code` so the shared code reader
 * classifies it like any other terminal rejection.
 */
export class NotApprovableError extends Error {
  readonly data = { code: 'NOT_APPROVABLE' };

  constructor() {
    super('The session has no cloud-agent permission to answer');
    this.name = 'NotApprovableError';
  }
}

/** Permission answers must not be batched into a composed request. */
const skipBatchOptions = { context: { skipBatch: true } };

/**
 * Resolve the cloud-agent (control-plane) session id from the kilo session id.
 * The same `cliSessionsV2.get` read `resolveSession` uses; a row without a
 * cloud-agent id is not approvable.
 */
async function resolveCloudAgentSessionId(kiloSessionId: string): Promise<string> {
  // The row id is a Kilo session id; the brand is only a compile-time marker.
  const session = await trpcClient.cliSessionsV2.get.query({
    session_id: kiloSessionId as KiloSessionId,
  });
  const cloudAgentSessionId = session.cloud_agent_session_id;
  if (!cloudAgentSessionId) {
    throw new NotApprovableError();
  }
  return cloudAgentSessionId;
}

export type AnswerSessionPermissionInput = {
  /**
   * Kilo platform session id. Only read when `cloudAgentSessionId` is absent:
   * the row resolves the cloud-agent id then.
   */
  kiloSessionId?: string;
  /** Cloud-agent session id when the caller already knows it. */
  cloudAgentSessionId?: string | null;
  organizationId?: string | null;
  /** The pending permission's id from the control plane's projection. */
  requestId: string;
  response: PermissionResponse;
};

/**
 * The single body that answers a cloud-agent permission: the in-app permission
 * card and the activity action both land here. Keeps the manager's
 * organization/personal branch and its `skipBatch` handling.
 */
export async function answerSessionPermission(input: AnswerSessionPermissionInput): Promise<void> {
  let sessionId = input.cloudAgentSessionId ?? null;
  if (!sessionId) {
    if (!input.kiloSessionId) {
      throw new NotApprovableError();
    }
    sessionId = await resolveCloudAgentSessionId(input.kiloSessionId);
  }
  const payload = {
    sessionId,
    permissionId: input.requestId,
    response: input.response,
  };
  if (input.organizationId) {
    await trpcClient.organizations.cloudAgentNext.answerPermission.mutate(
      { ...payload, organizationId: input.organizationId },
      skipBatchOptions
    );
    return;
  }
  await trpcClient.cloudAgentNext.answerPermission.mutate(payload, skipBatchOptions);
}

/** The interaction identity the control plane's projection guarantees. */
const pendingPermissionSchema = z.object({ id: z.string().min(1) });

/** The `connected` frame's interaction projection; absent means none pending. */
const connectedInteractionsSchema = z.object({
  pendingInteractions: z.object({ permissions: z.array(pendingPermissionSchema) }).optional(),
});

type StreamConnectionLike = { connect: () => void; destroy: () => void };

export type PendingPermissionResolverDeps = {
  getTicket?: (
    cloudAgentSessionId: string,
    organizationId?: string
  ) => Promise<{ ticket: string; expiresAt: number }>;
  createConnection?: (config: ConnectionConfig) => StreamConnectionLike;
  now?: () => number;
  /**
   * Schedule the deadline and return its cancel function. Injectable so the
   * pure suite fires the deadline by hand and no opaque timer handle leaks.
   */
  setTimeout?: (handler: () => void, timeoutMs: number) => () => void;
};

export type ResolvePendingPermissionIdInput = {
  cloudAgentSessionId: string;
  organizationId?: string | null;
  timeoutMs?: number;
};

/** Flat budget for one control-plane stream open. */
const PENDING_PERMISSION_TIMEOUT_MS = 15_000;

/**
 * Read the pending permission's id from the cloud-agent control plane. The id
 * lives only in the control plane's pending-interaction projection and is sent
 * on stream connect, so this reuses the shipped stream transport for one frame
 * and closes it. Resolves `null` when the connect carries no pending permission
 * or the deadline fires.
 */
export async function resolvePendingPermissionId(
  input: ResolvePendingPermissionIdInput,
  deps?: PendingPermissionResolverDeps
): Promise<string | null> {
  const getTicket = deps?.getTicket ?? fetchCloudAgentStreamTicket;
  const openConnection = deps?.createConnection ?? createConnection;
  const now = deps?.now ?? (() => Date.now());
  const setTimer =
    deps?.setTimeout ??
    ((handler: () => void, timeoutMs: number) => {
      const handle = setTimeout(handler, timeoutMs);
      return () => {
        clearTimeout(handle);
      };
    });
  const organizationId =
    input.organizationId && input.organizationId.length > 0 ? input.organizationId : undefined;
  const timeoutMs = input.timeoutMs ?? PENDING_PERMISSION_TIMEOUT_MS;
  const deadlineAt = now() + timeoutMs;

  const ticket = await getTicket(input.cloudAgentSessionId, organizationId);

  return new Promise<string | null>(resolve => {
    let settled = false;
    let cancelDeadline: (() => void) | null = null;
    let connection: StreamConnectionLike | null = null;
    const settle = (permissionId: string | null): void => {
      if (settled) {
        return;
      }
      settled = true;
      cancelDeadline?.();
      connection?.destroy();
      resolve(permissionId);
    };
    cancelDeadline = setTimer(() => {
      settle(null);
    }, timeoutMs);
    const url = new URL('/stream', CLOUD_AGENT_WS_URL);
    url.searchParams.set('cloudAgentSessionId', input.cloudAgentSessionId);
    connection = openConnection({
      websocketUrl: url.toString(),
      ticket,
      websocketHeaders: { Origin: WEB_BASE_URL },
      lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
      onEvent: event => {
        if (event.streamEventType !== 'connected') {
          return;
        }
        // A frame that lands after the deadline is not an answer.
        if (now() >= deadlineAt) {
          settle(null);
          return;
        }
        const parsed = connectedInteractionsSchema.safeParse(event.data);
        const permissionId = parsed.success
          ? (parsed.data.pendingInteractions?.permissions[0]?.id ?? null)
          : null;
        settle(permissionId);
      },
      onConnected: () => undefined,
      onDisconnected: () => undefined,
      onError: () => undefined,
    });
    // `createConnection` builds the transport; the caller opens it.
    connection.connect();
  });
}

/** Terminal codes: the ask is already answered or no longer pending. */
const GONE_TRPC_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'PRECONDITION_FAILED',
  'NOT_APPROVABLE',
]);

function classifyApproveFailure(error: unknown): GlanceableApproveResult {
  const code = readTrpcErrorField(error, 'code');
  if (code !== undefined && GONE_TRPC_CODES.has(code)) {
    return { kind: 'gone' };
  }
  // A transport, timeout, or 5xx failure is worth another tap.
  return { kind: 'retryable' };
}

/**
 * The flow both platforms run on an Approve tap. A question ask and a legacy
 * wrapper session have no single approval, so both are `none` and the caller
 * drops the action; an answered-elsewhere ask is `gone`.
 */
export async function runGlanceableApprove(
  options: { now?: () => number } = {}
): Promise<GlanceableApproveResult> {
  const ask = await readWaitingAsk();
  if (ask?.status !== 'permission' || !ask.isCloudAgent) {
    return { kind: 'none' };
  }
  try {
    const cloudAgentSessionId = await resolveCloudAgentSessionId(ask.kiloSessionId);
    const permissionId = await resolvePendingPermissionId(
      { cloudAgentSessionId, organizationId: ask.organizationId },
      options.now ? { now: options.now } : undefined
    );
    if (permissionId === null) {
      return { kind: 'gone' };
    }
    await answerSessionPermission({
      kiloSessionId: ask.kiloSessionId,
      cloudAgentSessionId,
      organizationId: ask.organizationId,
      requestId: permissionId,
      response: 'once',
    });
    recordWaitingAsk(null);
    return { kind: 'approved' };
  } catch (error) {
    return classifyApproveFailure(error);
  }
}

/** One poll cadence tick while the answered session still shows as waiting. */
const GLANCEABLE_REFRESH_POLL_MS = 1000;
/** The poll budget: `cli_sessions_v2.status` syncs asynchronously. */
const GLANCEABLE_REFRESH_DEADLINE_MS = 10_000;

/** Statuses that still mean the answered ask has not cleared server-side. */
const ANSWERED_BUT_WAITING_STATUSES: ReadonlySet<string> = new Set(['permission', 'question']);

/** One tray row: the snapshot fields plus the id the recorded ask names. */
type TraySessionRow = GlanceableSessionRow & { id: string };

type GlanceableSnapshotPublisher = {
  handleSessions(
    rows: readonly GlanceableSessionRow[],
    ctx: { userId: string; organizationId: string | null }
  ): void;
};

export type RefreshGlanceableSnapshotDeps = {
  fetchRows?: (organizationId: string | null) => Promise<readonly TraySessionRow[]>;
  createPublisher?: () => GlanceableSnapshotPublisher;
  sleep?: (ms: number) => Promise<void>;
  pollIntervalMs?: number;
  deadlineMs?: number;
};

async function defaultFetchTrayRows(
  organizationId: string | null
): Promise<readonly TraySessionRow[]> {
  const data = await trpcClient.activeSessions.list.query(
    buildActiveSessionsTrayInput(organizationId)
  );
  return data.sessions;
}

/** One poll tick's fetch; `null` means the fetch failed. */
async function fetchTrayRowsOrNull(
  fetchRows: (organizationId: string | null) => Promise<readonly TraySessionRow[]>,
  organizationId: string | null
): Promise<readonly TraySessionRow[] | null> {
  try {
    const rows = await fetchRows(organizationId);
    return rows;
  } catch {
    return null;
  }
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(() => {
      resolve();
    }, ms);
  });
}

function hasWaitingAnsweredSession(
  rows: readonly TraySessionRow[],
  kiloSessionId: string
): boolean {
  const row = rows.find(candidate => candidate.id === kiloSessionId);
  return row !== undefined && ANSWERED_BUT_WAITING_STATUSES.has(row.status);
}

/**
 * Republish the tray after a successful answer, through the same publisher
 * factory the app mounts, so every registered sink (Android notification, iOS
 * activity, widget, persistence) updates. The first real response is published
 * immediately, then polled until the answered session leaves
 * permission/question or the 10 s budget runs out. A failed fetch ends the poll
 * and leaves the last real snapshot in place: counts are never invented.
 */
export async function refreshGlanceableSnapshot(
  input: { userId: string; organizationId: string | null; answeredKiloSessionId: string },
  deps?: RefreshGlanceableSnapshotDeps
): Promise<void> {
  const fetchRows = deps?.fetchRows ?? defaultFetchTrayRows;
  const createPublisher: () => GlanceableSnapshotPublisher =
    deps?.createPublisher ?? createGlanceablePublisher;
  const sleep = deps?.sleep ?? defaultSleep;
  const pollMs = deps?.pollIntervalMs ?? GLANCEABLE_REFRESH_POLL_MS;
  const deadlineMs = deps?.deadlineMs ?? GLANCEABLE_REFRESH_DEADLINE_MS;
  const publisher = createPublisher();
  const ctx = { userId: input.userId, organizationId: input.organizationId };
  let elapsedMs = 0;
  for (;;) {
    // eslint-disable-next-line no-await-in-loop -- one fetch per poll tick
    const rows = await fetchTrayRowsOrNull(fetchRows, input.organizationId);
    if (rows === null) {
      // The last published snapshot stays; nothing is fabricated.
      return;
    }
    publisher.handleSessions(rows, ctx);
    if (elapsedMs >= deadlineMs || !hasWaitingAnsweredSession(rows, input.answeredKiloSessionId)) {
      return;
    }
    // eslint-disable-next-line no-await-in-loop -- 1 s poll cadence
    await sleep(pollMs);
    elapsedMs += pollMs;
  }
}
