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
 * A successful interaction acks session attention exactly as the in-app
 * control does, and the manager is destroyed on every path.
 *
 * Outcomes:
 * - `ok` — the matching raise was answered and acked.
 * - `retryable` — a transport / tRPC failure, or the tap carried no answer
 *   while the raise is still live (blank reply text, or a pending raise of the
 *   other kind): nothing was sent, so the caller may offer a retry.
 * - `unavailable` — the session is gone (`NOT_FOUND`), or no raise of either
 *   kind appeared within the budget.
 */

import { type Atom, createStore } from 'jotai';
import { type JotaiStore, type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { createUserWebConnection } from '@kilocode/cloud-agent-sdk/user-web-connection';
import * as SecureStore from 'expo-secure-store';

import { createMobileAgentSessionManager } from '@/components/agents/mobile-session-manager';
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
 * the two atoms this module reads.
 */
export type NeedsInputSessionManager = {
  switchSession(kiloSessionId: KiloSessionId): Promise<void>;
  respondToPermission(requestId: string, response: 'once'): Promise<void>;
  answerQuestion(requestId: string, answers: string[][]): Promise<void>;
  destroy(): void;
  atoms: {
    activePermission: Atom<PendingRequest | null>;
    activeQuestion: Atom<PendingRequest | null>;
  };
};

type ManagerFactoryOptions = {
  store: JotaiStore;
  organizationId: string | undefined;
  userId: string;
};

/** The session row this module needs: existence and the manager's org scope. */
type SessionRow = { organization_id?: string | null };

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

  let organizationId: string | undefined = undefined;
  try {
    const session = await getSession(kiloSessionId);
    organizationId = session.organization_id ?? undefined;
  } catch (error) {
    // A session the user can no longer see is stale, not retryable; every
    // other read failure (deadline, 5xx, offline) may succeed on a later tap.
    return readTrpcErrorField(error, 'code') === 'NOT_FOUND' ? 'unavailable' : 'retryable';
  }

  try {
    const userId = (await getUserId()) ?? '';
    const manager = createManager({ store, organizationId, userId });
    try {
      // The id arrives from the notification payload as a plain string; the
      // session read above proved it is a real session, which is the invariant
      // the branded type stands for.
      await manager.switchSession(kiloSessionId as KiloSessionId);
      const requestId = await waitForPendingRequestId({
        store,
        manager,
        action,
        now,
        sleep,
        waitBudgetMs,
        pollIntervalMs,
      });
      if (requestId === null) {
        // No raise of this kind inside the budget: nothing was sent. When the
        // session instead holds a raise of the other kind, that raise is still
        // live and untouched — the user tapped the wrong control — so the
        // notification must keep its actions for a tap on the right one.
        const oppositeRequest = store.get(
          action === 'approve' ? manager.atoms.activeQuestion : manager.atoms.activePermission
        );
        return oppositeRequest === null ? 'unavailable' : 'retryable';
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

/* eslint-disable @typescript-eslint/promise-function-async, require-await -- thin trpc / SecureStore / timer passthroughs */
async function defaultGetSession(kiloSessionId: string): Promise<SessionRow> {
  return trpcClient.cliSessionsV2.get.query({ session_id: kiloSessionId });
}

async function defaultGetUserId(): Promise<string | null> {
  return SecureStore.getItemAsync(ACTIVE_USER_ID_KEY);
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
