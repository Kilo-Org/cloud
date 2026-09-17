import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type GlanceableSessionRow } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { performRefresh } from '@/lib/auth/credentials';
import { StreamTicketHttpError } from '@/lib/cloud-agent-stream-ticket';
import { trpcClient } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

import { createGlanceablePublisher } from './create-publisher';
import { resolvePendingPermissionId } from './pending-permission';
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

/** Terminal codes: the ask is already answered or no longer pending. */
const GONE_TRPC_CODES: ReadonlySet<string> = new Set([
  'NOT_FOUND',
  'PRECONDITION_FAILED',
  'NOT_APPROVABLE',
]);

/** The code the API answers when the request carried no usable session. */
const UNAUTHORIZED_CODE = 'UNAUTHORIZED';

/**
 * The stream-ticket statuses that mean this caller can never stream the ask's
 * session: the route answers 403 for a session the user does not own and 404
 * for one it cannot find, and neither changes on a second tap.
 */
const GONE_TICKET_STATUSES: ReadonlySet<number> = new Set([400, 403, 404, 410]);

function classifyApproveFailure(error: unknown): GlanceableApproveResult {
  if (error instanceof StreamTicketHttpError && GONE_TICKET_STATUSES.has(error.status)) {
    return { kind: 'gone' };
  }
  const code = readTrpcErrorField(error, 'code');
  if (code !== undefined && GONE_TRPC_CODES.has(code)) {
    return { kind: 'gone' };
  }
  // A transport, timeout, or 5xx failure is worth another tap.
  return { kind: 'retryable' };
}

/**
 * A tap that arrives unauthenticated, and what that means for the ask.
 *
 * The background contexts have no app root and no foreground refresh timer, so
 * this is the path that first sees a rotated access token; a refresh is the
 * only way to tell a rotation (retryable) from credentials that cannot be
 * recovered at all. An unrecoverable session can never answer this ask from the
 * surface, so the action is dropped like any other terminal answer instead of
 * offering an "tap Approve to try again" that can never succeed.
 */
async function classifyUnauthorized(): Promise<GlanceableApproveResult> {
  const refreshed = await performRefresh();
  if (!refreshed.ok && refreshed.refused) {
    return { kind: 'gone' };
  }
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
    if (readTrpcErrorField(error, 'code') === UNAUTHORIZED_CODE) {
      return classifyUnauthorized();
    }
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
    deps?.createPublisher ??
    (() =>
      createGlanceablePublisher({
        // The tray's row for the session this refresh just answered can still
        // read permission/question while the control plane's status sync lands.
        // Recording that row again would put Approve back on the notification
        // the user already actioned, so the answered session is dropped here
        // for this refresh only; the counts still come from the tray.
        onWaitingAskChange: ask => {
          if (ask !== null && ask.kiloSessionId === input.answeredKiloSessionId) {
            return;
          }
          recordWaitingAsk(ask);
        },
      }));
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
