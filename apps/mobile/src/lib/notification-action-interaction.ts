/**
 * Headless entry point for the notification Approve and Reply actions.
 *
 * The owner request is that a needs-input notification is answered without
 * opening the app. This module is the one place that does the work: it builds
 * the same mobile session manager `session-provider.tsx` builds, without
 * React, switches to the notified session, waits for the same
 * `activePermission` / `activeQuestion` atoms the in-app blocking card reads,
 * and then calls the same `respondToPermission` / `answerQuestion` methods
 * `use-interaction-handlers` calls. Approval is never re-implemented here.
 * A terminal outcome acks session attention exactly as the in-app control
 * does — the answered raise (`ok`) and the raise proven to be gone
 * (`unavailable`) both stop showing as waiting — and the manager is destroyed
 * on every path.
 *
 * Outcomes:
 * - `ok` — the matching raise was answered and acked; or an approve found the
 *   live session authoritatively free of the ask while the session's status
 *   still reads needs-input: the raise is still raised server-side but has
 *   nothing left to forward it to, so the user's approve ends it (the raise
 *   the notification offered was approved; the ack stops it showing as
 *   waiting).
 * - `retryable` — a transport / tRPC failure, or nothing was sent because the
 *   raise had not reached the atoms yet (blank reply text, a pending raise of
 *   the other kind, a reply whose still-raised session holds no question, a
 *   wait budget that expired before a live transport opened, a session that
 *   resolved read-only, or an outcome-time status read that failed): the raise
 *   may still be live, so the caller keeps the actions and the user can tap
 *   again.
 * - `unavailable` — the session read returned `NOT_FOUND`, or a live transport
 *   opened, replayed its snapshot, and reported no raise of either kind while
 *   the session's status has moved on: the raise is authoritatively gone
 *   (answered elsewhere), so another tap can never succeed and the caller
 *   drops the actions. Absence only counts once the live snapshot is proven to
 *   have landed (see `liveSnapshotLanded`); a budget that expires while the
 *   transport is still `connecting`, or on a session that resolved `read-only`
 *   or never opened its socket, proves nothing — with the app closed, a cold
 *   headless start (ticket mint, connect, snapshot replay) can exceed the
 *   budget while the raise is still live — so those stay retryable.
 */

import { type Atom, createStore } from 'jotai';
import {
  type ActiveSessionType,
  type AgentStatus,
  type JotaiStore,
  type KiloSessionId,
  type SessionActivity,
} from '@kilocode/cloud-agent-sdk';
import { createUserWebConnection } from '@kilocode/cloud-agent-sdk/user-web-connection';

import { createMobileAgentSessionManager } from '@/components/agents/mobile-session-manager';
import { readStoredValue } from '@/lib/auth/secure-store-value';
import { SESSION_INGEST_WS_URL } from '@/lib/config';
import { ackSessionAttention } from '@/lib/session-attention';
import { ACTIVE_USER_ID_KEY } from '@/lib/storage-keys';
import { trpcClient } from '@/lib/trpc';
import { readTrpcErrorField } from '@/lib/trpc-error';
import { createNativeUserWebConnectionLifecycleHooks } from '@/lib/user-web-connection-lifecycle';

export type NeedsInputAction = 'approve' | 'reply';

export type NeedsInputActionOutcome = 'ok' | 'retryable' | 'unavailable';

/** The id-bearing shape both standalone pending-request atoms hold. */
type PendingRequest = { requestId: string };

/**
 * The manager surface this entry point drives. Narrower than the SDK's
 * `SessionManager` so a test can drive it with a fake that only has to provide
 * the atoms this module reads.
 */
export type NeedsInputSessionManager = {
  switchSession(kiloSessionId: KiloSessionId): Promise<void>;
  respondToPermission(requestId: string, response: 'once'): Promise<void>;
  answerQuestion(requestId: string, answers: string[][]): Promise<void>;
  destroy(): void;
  atoms: {
    activePermission: Atom<PendingRequest | null>;
    activeQuestion: Atom<PendingRequest | null>;
    /**
     * The session's activity. `connecting` means no snapshot has landed yet,
     * so an empty raise atom proves nothing; any other value means the
     * transport resolved and its connect was processed.
     */
    activity: Atom<SessionActivity>;
    /**
     * The resolved transport kind. Only `remote` and `cloud-agent` open a live
     * socket whose connect replays the pending asks; `read-only` (and the
     * `null` a failed resolve leaves behind) never does.
     */
    sessionType: Atom<ActiveSessionType | null>;
    /** True when the session structurally cannot accept input. */
    isReadOnly: Atom<boolean>;
    /** Agent lifecycle status; `error` / `disconnected` mean the open failed. */
    agentStatus: Atom<AgentStatus>;
  };
};

type ManagerFactoryOptions = {
  store: JotaiStore;
  organizationId: string | undefined;
  userId: string;
};

/**
 * The session row this module needs: existence, the manager's org scope, and
 * the status that decides a proven-absent raise's outcome.
 */
type SessionRow = { organization_id?: string | null; status?: string | null };

export type NeedsInputInteractionDeps = {
  /**
   * Session lookup that also yields the manager's organization scope.
   * Defaults to `cliSessionsV2.get`; `NOT_FOUND` means the notification is
   * stale rather than retryable.
   */
  getSession?: (kiloSessionId: string) => Promise<SessionRow>;
  /**
   * Manager factory. Defaults to the app's mobile manager over a native
   * user-web connection, matching `session-provider.tsx` without React.
   */
  createManager?: (options: ManagerFactoryOptions) => NeedsInputSessionManager;
  /** Jotai store the manager writes its atoms into. */
  store?: JotaiStore;
  /** Reads the authenticated user id that scopes the transcript cache. */
  getUserId?: () => Promise<string | null>;
  /** Records the session-attention ack after a successful interaction. */
  ack?: (kiloSessionId: string) => void;
  /** Clock the wait for the raise is bounded by. */
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  waitBudgetMs?: number;
  pollIntervalMs?: number;
  /** Re-poll window for a raise that trails the live snapshot (see the constant). */
  missingRaiseSettleMs?: number;
};

export type NeedsInputInteractionInput = {
  /** Kilo session id from the notification payload. Never a cloud-agent id. */
  kiloSessionId: string;
  action: NeedsInputAction;
  /** The typed answer for `reply`. Never read for `approve`. */
  text?: string;
  deps?: NeedsInputInteractionDeps;
};

/** Bounded wait for the raise to reach the manager's atoms. */
const DEFAULT_WAIT_BUDGET_MS = 8000;
const DEFAULT_POLL_INTERVAL_MS = 100;
/**
 * Extra time re-polled for a raise that trails the live snapshot. The transport
 * clears the pending sets on connect and replays whatever is still pending as
 * its own events right after, so a short settle window keeps that replay from
 * being misread as an absent raise.
 */
const DEFAULT_MISSING_RAISE_SETTLE_MS = 1000;

export async function runNeedsInputInteraction({
  kiloSessionId,
  action,
  text,
  deps,
}: NeedsInputInteractionInput): Promise<NeedsInputActionOutcome> {
  const replyText = text ?? '';
  // A reply with no answer text has nothing to send. Nothing is created and
  // the raise is untouched: the notification keeps its actions so the user can
  // tap Reply again with text, so the outcome is retryable, not gone.
  if (action === 'reply' && replyText.trim() === '') {
    return 'retryable';
  }

  const now = deps?.now ?? Date.now;
  const sleep = deps?.sleep ?? defaultSleep;
  const store = deps?.store ?? createStore();
  const ack = deps?.ack ?? ackSessionAttention;
  const getSession = deps?.getSession ?? defaultGetSession;
  const getUserId = deps?.getUserId ?? defaultGetUserId;
  const createManager = deps?.createManager ?? defaultCreateManager;
  const waitBudgetMs = deps?.waitBudgetMs ?? DEFAULT_WAIT_BUDGET_MS;
  const pollIntervalMs = deps?.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const missingRaiseSettleMs = deps?.missingRaiseSettleMs ?? DEFAULT_MISSING_RAISE_SETTLE_MS;

  let organizationId: string | undefined = undefined;
  try {
    const session = await getSession(kiloSessionId);
    organizationId = session.organization_id ?? undefined;
  } catch (error) {
    // A session the user can no longer see is stale, not retryable; every
    // other read failure (deadline, 5xx, offline) may succeed on a later tap.
    if (readTrpcErrorField(error, 'code') === 'NOT_FOUND') {
      ack(kiloSessionId);
      return 'unavailable';
    }
    return 'retryable';
  }

  try {
    const userId = (await getUserId()) ?? '';
    const manager = createManager({ store, organizationId, userId });
    try {
      // The id arrives from the notification payload as a plain string; the
      // session read above proved it is a real session, which is the invariant
      // the branded type stands for.
      await manager.switchSession(kiloSessionId as KiloSessionId);
      let requestId = await waitForPendingRequestId({
        store,
        manager,
        action,
        now,
        sleep,
        waitBudgetMs,
        pollIntervalMs,
      });
      if (requestId === null) {
        // No raise of this kind reached the atoms inside the budget and
        // nothing was sent. The budget alone is not proof the raise is gone:
        // with the app closed, a cold headless start (ticket mint, connect,
        // snapshot replay) can exceed it while the raise is still live. Only a
        // proven live snapshot (see `liveSnapshotLanded`) makes the empty
        // atoms authoritative — then the raise's outcome is decided by the
        // session's own raise state (see `resolveMissingRequestId`).
        const resolution = await resolveMissingRequestId({
          store,
          manager,
          action,
          kiloSessionId,
          sleep,
          pollIntervalMs,
          missingRaiseSettleMs,
          getSession,
          // A raise that cannot be answered ends the raise for the user: it
          // was answered elsewhere, or no agent ever asked it (a status-only
          // raise). Ack it so the Agents row and tab badge stop offering a tap
          // that can no longer do anything — the same clear a successful
          // answer performs.
          ackGone: () => {
            ack(kiloSessionId);
          },
        });
        if (resolution.kind === 'answered') {
          requestId = resolution.requestId;
        } else if (resolution.kind === 'ended') {
          return resolution.outcome;
        } else {
          return 'retryable';
        }
      }
      await (action === 'approve'
        ? manager.respondToPermission(requestId, 'once')
        : manager.answerQuestion(requestId, [[replyText]]));
      ack(kiloSessionId);
      return 'ok';
    } finally {
      manager.destroy();
    }
  } catch {
    // Manager setup, the switch, the answer, and the ticket mint can all throw
    // on a dead transport. The raise is untouched, so a retry is safe.
    return 'retryable';
  }
}

/**
 * Read the request id of the pending raise that matches `action`, or null when
 * the manager's atoms hold no matching raise yet.
 */
function readPendingRequestId(
  store: JotaiStore,
  manager: NeedsInputSessionManager,
  action: NeedsInputAction
): string | null {
  const request = store.get(
    action === 'approve' ? manager.atoms.activePermission : manager.atoms.activeQuestion
  );
  const requestId = request?.requestId;
  return requestId ?? null;
}

/**
 * Wait for the matching raise to reach the atoms the in-app card reads. Polling
 * (rather than an atom subscription) keeps the whole wait on the injectable
 * clock, so tests settle deterministically.
 */
async function waitForPendingRequestId(args: {
  store: JotaiStore;
  manager: NeedsInputSessionManager;
  action: NeedsInputAction;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  waitBudgetMs: number;
  pollIntervalMs: number;
}): Promise<string | null> {
  const { store, manager, action, now, sleep, waitBudgetMs, pollIntervalMs } = args;
  const deadlineMs = now() + waitBudgetMs;
  for (;;) {
    const requestId = readPendingRequestId(store, manager, action);
    if (requestId !== null) {
      return requestId;
    }
    if (now() >= deadlineMs) {
      return null;
    }
    // eslint-disable-next-line no-await-in-loop -- bounded poll cadence
    await sleep(pollIntervalMs);
  }
}

/**
 * Whether the manager holds positive evidence that a live transport opened and
 * its snapshot landed, which is what makes the empty raise atoms authoritative.
 *
 * Activity no longer being `connecting` is NOT that evidence on its own: a
 * failed `resolveSession` and a transport that could not be created both land
 * `idle` with no live socket at all, and a `read-only` (historical) resolution
 * never opens one. All of the following are required:
 * - a live transport kind (`remote` / `cloud-agent`) — never `read-only`, and
 *   never the `null` a failed resolve leaves behind;
 * - `isReadOnly` false, so the resolved session can actually accept an answer;
 * - the agent status is neither `error` nor `disconnected`, the two ways a
 *   resolved session fails before its snapshot ever lands;
 * - activity left `connecting`: a live transport processed its connect, which
 *   clears the pending sets and then replays whatever is still pending.
 */
function liveSnapshotLanded(store: JotaiStore, manager: NeedsInputSessionManager): boolean {
  const sessionType = store.get(manager.atoms.sessionType);
  if (sessionType !== 'remote' && sessionType !== 'cloud-agent') {
    return false;
  }
  if (store.get(manager.atoms.isReadOnly)) {
    return false;
  }
  const agentStatus = store.get(manager.atoms.agentStatus).type;
  if (agentStatus === 'error' || agentStatus === 'disconnected') {
    return false;
  }
  return store.get(manager.atoms.activity).type !== 'connecting';
}

/**
 * Classify a wait that ended with no matching raise in the atoms.
 *
 * Retryable — the raise may still be live, so the caller keeps the actions:
 * - the session has no proven live snapshot (still `connecting`, resolved
 *   `read-only`, or failed to resolve / open), so the empty atoms are silence
 *   rather than authoritative absence;
 * - a raise of the other kind is pending, so the wrong-kind tap must not end a
 *   live raise the other action can still answer;
 * - the action is a reply with no pending question: a reply only ends a raise
 *   it actually answered, and a permission raise (where no question can be
 *   pending) must stay open for its Approve control.
 *
 * Terminal otherwise: a live transport opened, its snapshot cleared the pending
 * sets and replayed whatever is still pending, so no pending raise means the
 * ask is gone. What the session's raise state says decides the outcome:
 * - the session's status is still a needs-input status — nobody answered the
 *   raise; there is only nothing left to forward it to. An approve ends the
 *   raise as the user's own action (`ok` — the user approved the raise the
 *   notification presented), which keeps a second tap after a transport fault
 *   succeeding instead of looping the gone body.
 * - the status moved on — the raise was answered elsewhere, so the outcome is
 *   `unavailable` ("no longer waiting").
 *
 * That replay follows the snapshot as its own events, so the atoms are
 * re-polled for a short settle window first and a matching raise that lands
 * with it is returned instead of being misread as gone.
 */
async function resolveMissingRequestId(args: {
  store: JotaiStore;
  manager: NeedsInputSessionManager;
  action: NeedsInputAction;
  kiloSessionId: string;
  sleep: (ms: number) => Promise<void>;
  pollIntervalMs: number;
  missingRaiseSettleMs: number;
  /** Fresh session read that yields the raise's current server-side status. */
  getSession: (kiloSessionId: string) => Promise<SessionRow>;
  /** Clears the raise's attention once it is proven gone. */
  ackGone: () => void;
}): Promise<
  | {
      kind: 'answered';
      requestId: string;
    }
  | { kind: 'ended'; outcome: 'ok' | 'unavailable' }
  | { kind: 'retryable' }
> {
  const {
    store,
    manager,
    action,
    kiloSessionId,
    sleep,
    pollIntervalMs,
    missingRaiseSettleMs,
    getSession,
    ackGone,
  } = args;
  const anyRaisePending = () =>
    store.get(manager.atoms.activePermission) !== null ||
    store.get(manager.atoms.activeQuestion) !== null;

  const polls = pollIntervalMs > 0 ? Math.ceil(missingRaiseSettleMs / pollIntervalMs) : 0;
  for (let poll = 0; poll < polls; poll += 1) {
    // eslint-disable-next-line no-await-in-loop -- bounded settle poll cadence
    await sleep(pollIntervalMs);
    const requestId = readPendingRequestId(store, manager, action);
    if (requestId !== null) {
      return { kind: 'answered', requestId };
    }
    if (!liveSnapshotLanded(store, manager) || anyRaisePending()) {
      return { kind: 'retryable' };
    }
  }

  if (!liveSnapshotLanded(store, manager) || anyRaisePending()) {
    return { kind: 'retryable' };
  }
  const raiseState = await readRaiseState(getSession, kiloSessionId);
  if (raiseState === 'unknown') {
    return { kind: 'retryable' };
  }
  if (raiseState === 'raised') {
    if (action === 'approve') {
      ackGone();
      return { kind: 'ended', outcome: 'ok' };
    }
    // A reply must never end a raise it did not answer: with the status still
    // raised and no question in the atoms, the raise may be a permission the
    // Approve control can still answer, so the actions stay.
    return { kind: 'retryable' };
  }
  ackGone();
  return { kind: 'ended', outcome: 'unavailable' };
}

/**
 * The raise's current server-side state, read fresh at outcome time: the raise
 * may have moved on (answered elsewhere) between the notification being posted
 * and this tap, which is exactly what separates an ended raise from a gone
 * one. A failed read cannot prove anything either way, so it reports
 * `unknown` — the caller keeps the actions rather than announcing an outcome
 * it cannot back.
 */
async function readRaiseState(
  getSession: (kiloSessionId: string) => Promise<SessionRow>,
  kiloSessionId: string
): Promise<'raised' | 'moved' | 'unknown'> {
  try {
    const { status } = await getSession(kiloSessionId);
    return status === 'question' || status === 'permission' ? 'raised' : 'moved';
  } catch {
    return 'unknown';
  }
}

/* eslint-disable @typescript-eslint/promise-function-async, require-await -- thin trpc / stored-value / timer passthroughs */
async function defaultGetSession(kiloSessionId: string): Promise<SessionRow> {
  return trpcClient.cliSessionsV2.get.query({ session_id: kiloSessionId });
}

/**
 * The active-user id, read through the one cross-platform SecureStore entry
 * point (`lib/auth/secure-store-value`) the glanceable sink and the in-app
 * approving surface also read: `expo-secure-store` exists on iOS and Android
 * alike, so no platform lacks the capability and this headless path keeps no
 * second, per-platform storage read. A headless Approve must resolve the same
 * account the in-app control would.
 */
async function defaultGetUserId(): Promise<string | null> {
  return readStoredValue(ACTIVE_USER_ID_KEY);
}

async function defaultSleep(ms: number): Promise<void> {
  await new Promise<void>(resolve => {
    setTimeout(resolve, ms);
  });
}
/* eslint-enable @typescript-eslint/promise-function-async, require-await */

/**
 * The real manager: the same construction `session-provider.tsx` performs,
 * minus React. `getAuthToken` mints the same `activeSessions.createWebTicket`
 * the in-app connection uses.
 */
function defaultCreateManager(options: ManagerFactoryOptions): NeedsInputSessionManager {
  return createMobileAgentSessionManager({
    store: options.store,
    userWebConnection: createUserWebConnection({
      websocketUrl: `${SESSION_INGEST_WS_URL}/api/user/web`,
      getAuthToken: async () => {
        const result = await trpcClient.activeSessions.createWebTicket.mutate();
        return result.token;
      },
      lifecycleHooks: createNativeUserWebConnectionLifecycleHooks(),
    }),
    organizationId: options.organizationId,
    userId: options.userId,
  });
}
