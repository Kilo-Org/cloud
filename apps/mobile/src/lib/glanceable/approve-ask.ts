import type * as ExpoCrypto from 'expo-crypto';
import { type GlanceableSessionRow } from '@kilocode/app-shared/glanceable-agents-snapshot';

import { buildActiveSessionsTrayInput } from '@/lib/active-sessions-live';
import { performRefresh } from '@/lib/auth/credentials';
import { StreamTicketHttpError } from '@/lib/cloud-agent-stream-ticket';
import { ackSessionAttention } from '@/lib/session-attention';
import { trpcClient } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';

import { whenAskBindingSettled } from './ask-binding';
import { NotApprovableError, resolveCloudAgentSessionId } from './cloud-agent-session';
import { createGlanceablePublisher } from './create-publisher';
import { resolveAnsweredRaises } from './attention-rows';
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
 *
 * One implementation serves both platforms. Only the app-closed transport
 * differs, and each is named at its own file: iOS has WidgetKit/ActivityKit
 * through `expo-widgets` (a Live Activity press rides an in-process
 * `LiveActivityUserInteraction`, `src/glanceable-ios/interaction.ts`) and has
 * no promoted ongoing notification; Android has the Live Update notification
 * whose Approve broadcast boots WorkManager headless JS
 * (`modules/active-agents-live-update/android/`, `src/glanceable-android/`)
 * and has no ActivityKit. The answer body, the failure classification, and the
 * republish stay here so the two surfaces cannot disagree.
 */

/** The three answers the in-app permission card sends. */
type PermissionResponse = 'once' | 'always' | 'reject';

/** What an activity surface does with the outcome of an approve attempt. */
export type GlanceableApproveResult =
  | { kind: 'approved' }
  | { kind: 'retryable' }
  | { kind: 'gone' }
  | { kind: 'none' };

/** Permission answers must not be batched into a composed request. */
const skipBatchOptions = { context: { skipBatch: true } };

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

/**
 * The stream-ticket status that means the tap's credential is expired or
 * missing, not that the ask is gone: the route answers 401 before it can decide
 * ownership. The background contexts have no foreground refresh timer, so a 401
 * has to run the same credential refresh an `UNAUTHORIZED` tRPC answer does;
 * without it the ask stays retryable but the next tap fails on the same dead
 * token, which only a refresh can rotate.
 */
const UNAUTHORIZED_TICKET_STATUS = 401;

/** True when the failure is a stale credential, whichever transport reported it. */
function isUnauthorizedApproveError(error: unknown): boolean {
  if (error instanceof StreamTicketHttpError && error.status === UNAUTHORIZED_TICKET_STATUS) {
    return true;
  }
  return readTrpcErrorField(error, 'code') === UNAUTHORIZED_CODE;
}

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
 * only way to repair it, and a repaired pair makes the next tap answer.
 *
 * It never ends the ask. An unauthenticated request proves nothing about the
 * permission: the session is still waiting, and only the control plane's own
 * terminal answers (a refused stream ticket, or NOT_FOUND, PRECONDITION_FAILED,
 * NOT_APPROVABLE) can show it was answered elsewhere. Dropping the record here
 * hid a still-waiting permission from the shade and offered no way to answer
 * it, so the tap stays retryable and the notification keeps Approve with the
 * retry line.
 */
async function classifyUnauthorized(): Promise<GlanceableApproveResult> {
  try {
    await performRefresh();
  } catch {
    // A transient refresh failure is the same retryable outcome as a refused one.
  }
  return { kind: 'retryable' };
}

/**
 * The flow both platforms run on an Approve tap. A question ask and a legacy
 * wrapper session have no single approval, so both are `none` and the caller
 * drops the action; an answered-elsewhere ask is `gone`. An aggregate ask with
 * no recorded binding — a record made before its read landed, or one whose read
 * failed — is `retryable` and answers nothing: no request is named, so none is
 * answered.
 *
 * A terminal outcome acks session attention, exactly as the other answer paths
 * do (`notification-action-interaction.ts`, `approve-front-agent.ts`): the
 * answered raise and the raise proven gone both stop counting as waiting. The
 * tray row still reads permission/question until the control plane's status
 * sync lands, so without the ack the caller's republish
 * (`refreshGlanceableSnapshot`) would resolve nothing and draw the pre-action
 * counts — the session the user just answered, still offered with Approve — back
 * onto the ongoing notification. A retryable outcome never acks: the ask is
 * still waiting, and the next tap has to answer that same session.
 */
export async function runGlanceableApprove(
  options: { now?: () => number; target?: GlanceableApproveTarget } = {}
): Promise<GlanceableApproveResult> {
  if (options.target !== undefined) {
    // A session card names its own session and request; the recorded ask is
    // the aggregate card's and stays as it is.
    const result = await answerPendingPermission(
      { ...options.target, permissionId: null },
      options
    );
    if (result.kind === 'approved' || result.kind === 'gone') {
      ackSessionAttention(options.target.kiloSessionId);
    }
    return result;
  }
  const ask = await readWaitingAsk();
  if (ask?.status !== 'permission' || !ask.isCloudAgent) {
    return { kind: 'none' };
  }
  if (ask.boundPermissionId === null) {
    // No request is named, so nothing can be answered. The tap stays
    // retryable because a fresh record or a completed read makes this same ask
    // answerable.
    return { kind: 'retryable' };
  }
  const result = await answerPendingPermission(
    { ...ask, approvalKey: null, permissionId: ask.boundPermissionId },
    options
  );
  if (result.kind === 'approved') {
    recordWaitingAsk(null);
  }
  if (result.kind === 'approved' || result.kind === 'gone') {
    ackSessionAttention(ask.kiloSessionId);
  }
  return result;
}

/**
 * The request one session card shows: its session and the approval key of the
 * permission it drew (SHA-256 hex of `JSON.stringify([sessionId, permissionId])`).
 */
export type GlanceableApproveTarget = {
  kiloSessionId: string;
  organizationId: string | null;
  approvalKey: string;
};

/** The approval key of one pending request, as the server mints it. */
async function approvalKeyOf(kiloSessionId: string, permissionId: string): Promise<string> {
  // Lazy require keeps the native digest out of the pure test graph.
  // eslint-disable-next-line typescript-eslint/no-require-imports, typescript-eslint/no-var-requires, unicorn/prefer-module -- lazy native load
  const { CryptoDigestAlgorithm, digestStringAsync } = require('expo-crypto') as typeof ExpoCrypto;
  const key = await digestStringAsync(
    CryptoDigestAlgorithm.SHA256,
    JSON.stringify([kiloSessionId, permissionId])
  );
  return key;
}

/**
 * The answer body, whose terminal outcome the caller acks. A caller that names
 * its request — the session card's approval key, or the aggregate ask's pending
 * permission id — answers only that request: the live request must match it, or
 * the outcome is `gone`.
 */
async function answerPendingPermission(
  target: {
    kiloSessionId: string;
    organizationId: string | null;
    approvalKey: string | null;
    /** The pending permission the aggregate surface drew; null for a card. */
    permissionId: string | null;
  },
  options: { now?: () => number }
): Promise<GlanceableApproveResult> {
  try {
    const cloudAgentSessionId = await resolveCloudAgentSessionId(target.kiloSessionId);
    const permissionId = await resolvePendingPermissionId(
      { cloudAgentSessionId, organizationId: target.organizationId },
      options.now ? { now: options.now } : undefined
    );
    if (permissionId === null) {
      return { kind: 'gone' };
    }
    if (target.permissionId !== null && permissionId !== target.permissionId) {
      return { kind: 'gone' };
    }
    if (
      target.approvalKey !== null &&
      (await approvalKeyOf(target.kiloSessionId, permissionId)) !== target.approvalKey
    ) {
      return { kind: 'gone' };
    }
    await answerSessionPermission({
      kiloSessionId: target.kiloSessionId,
      cloudAgentSessionId,
      organizationId: target.organizationId,
      requestId: permissionId,
      response: 'once',
    });
    return { kind: 'approved' };
  } catch (error) {
    if (isUnauthorizedApproveError(error)) {
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
  /** Write the last frame again, for a fact the sinks read at draw time. */
  redraw?: () => void;
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
 * Republish the tray after an activity action ran, through the same publisher
 * factory the app mounts, so every registered sink (Android notification, iOS
 * activity, widget, persistence) updates. The first real response is published
 * immediately, then polled until the actioned session leaves
 * permission/question or the 10 s budget runs out. A failed fetch ends the poll
 * and leaves the last real snapshot in place: counts are never invented.
 *
 * The counts are the ack-resolved ones (`resolveAnsweredRaises`), like every
 * other republish path (`mount.tsx`, `widget-actions.ts`, `approve-front-agent`):
 * the action just recorded the session-attention ack, while its tray row still
 * reads permission/question until the control plane's status sync lands, so the
 * raw rows would republish the pre-action snapshot — the answered session still
 * counted as waiting — immediately after the user answered it. The poll below
 * still reads the raw row, because that is what proves the sync landed.
 */
export async function refreshGlanceableSnapshot(
  input: {
    userId: string;
    organizationId: string | null;
    /** The session the action named; polled until its row stops waiting. */
    answeredKiloSessionId: string;
    /**
     * Whether the action ended the ask — the answer landed, or it was already
     * gone. Only then is that session's row a stale one to skip at selection: a
     * retryable failure leaves the ask waiting, so its row is the truth, and
     * skipping it would clear the record the second tap needs or move that tap
     * to another waiting session.
     */
    askEnded: boolean;
  },
  deps?: RefreshGlanceableSnapshotDeps
): Promise<void> {
  const fetchRows = deps?.fetchRows ?? defaultFetchTrayRows;
  const createPublisher: () => GlanceableSnapshotPublisher =
    deps?.createPublisher ??
    (() =>
      createGlanceablePublisher({
        // The tray's row for the session this refresh just answered can still
        // read permission/question while the control plane's status sync lands,
        // and it is usually the oldest asking row, so an ended ask's selection
        // has to skip it: recording it would put Approve back on the
        // notification the user already actioned. Dropping the selected ask
        // instead would leave a second waiting session unrecorded, so the skip
        // happens at selection.
        skipWaitingAskSessionId: input.askEnded ? input.answeredKiloSessionId : undefined,
        // This publisher lives for one refresh: the binding wait below redraws
        // it, and a subscription would outlive it in the module-level listener
        // set.
        redrawOnAskBound: false,
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
      break;
    }
    publisher.handleSessions(resolveAnsweredRaises(rows), ctx);
    if (elapsedMs >= deadlineMs || !hasWaitingAnsweredSession(rows, input.answeredKiloSessionId)) {
      break;
    }
    // eslint-disable-next-line no-await-in-loop -- 1 s poll cadence
    await sleep(pollMs);
    elapsedMs += pollMs;
  }
  // The surface reads the ask's request binding at draw time, and the select
  // above starts that read. The headless caller ends with this promise, so wait
  // for it and draw again: the card left behind must offer Approve for the ask
  // it names, not the frame written before the binding landed.
  await whenAskBindingSettled();
  publisher.redraw?.();
}
