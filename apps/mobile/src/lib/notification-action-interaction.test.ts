/* eslint-disable max-lines, require-await, @typescript-eslint/require-await -- one suite pins every notification-action outcome; the injectable fakes settle without await */
import { atom, createStore, type PrimitiveAtom } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type ActiveSessionType,
  type AgentStatus,
  type SessionActivity,
} from '@kilocode/cloud-agent-sdk';
import {
  type NeedsInputSessionManager,
  runNeedsInputInteraction,
} from '@/lib/notification-action-interaction';

// Keep this suite on the pure vitest project: the entry point builds the real
// mobile manager and user-web connection, so every RN / Expo / tRPC side-effect
// import it reaches is mocked before the module under test loads.
const {
  getSessionQuery,
  createWebTicketMutate,
  readStoredValueMock,
  createMobileAgentSessionManagerMock,
  createUserWebConnectionMock,
} = vi.hoisted(() => ({
  getSessionQuery: vi.fn(),
  createWebTicketMutate: vi.fn(),
  readStoredValueMock: vi.fn(async () => 'user-1'),
  createMobileAgentSessionManagerMock: vi.fn(
    (_options: ManagerFactoryArgs): NeedsInputSessionManager => {
      throw new Error('createMobileAgentSessionManager not stubbed for this test');
    }
  ),
  createUserWebConnectionMock: vi.fn((_options: UserWebConnectionOptions) => ({})),
}));

// The one cross-platform SecureStore entry point is mocked, not
// `expo-secure-store`: a regression to a direct platform import in the module
// under test would bypass this mock and fail the storage assertions below.
vi.mock('@/lib/auth/secure-store-value', () => ({
  readStoredValue: readStoredValueMock,
}));
vi.mock('sonner-native', () => ({
  toast: { error: vi.fn(), success: vi.fn() },
}));
vi.mock('@/lib/config', () => ({
  SESSION_INGEST_WS_URL: 'wss://ingest.test',
}));
vi.mock('@/lib/user-web-connection-lifecycle', () => ({
  createNativeUserWebConnectionLifecycleHooks: vi.fn(() => ({})),
}));
vi.mock('@/components/agents/mobile-session-manager', () => ({
  createMobileAgentSessionManager: createMobileAgentSessionManagerMock,
}));
vi.mock('@kilocode/cloud-agent-sdk/user-web-connection', () => ({
  createUserWebConnection: createUserWebConnectionMock,
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cliSessionsV2: { get: { query: getSessionQuery } },
    activeSessions: { createWebTicket: { mutate: createWebTicketMutate } },
  },
}));

const SESSION_ID = 'ses_notification_action_0001';

type PendingRequest = { requestId: string };

/** The connection options the entry point hands the SDK's web connection. */
type UserWebConnectionOptions = {
  websocketUrl: string;
  getAuthToken: () => Promise<string>;
  lifecycleHooks: unknown;
};

/** The options the entry point hands the mobile manager factory. */
type ManagerFactoryArgs = {
  store: ReturnType<typeof createStore>;
  userWebConnection: unknown;
  organizationId: string | undefined;
  userId: string;
};

/** The atoms whose writes simulate the raise arriving on the live session. */
type RaiseSeeds = {
  store: ReturnType<typeof createStore>;
  activePermission: PrimitiveAtom<PendingRequest | null>;
  activeQuestion: PrimitiveAtom<PendingRequest | null>;
  /** Transport activity; `connecting` until the snapshot lands. */
  activity: PrimitiveAtom<SessionActivity>;
  /** Resolved transport kind; `remote` stands for an opened live socket. */
  sessionType: PrimitiveAtom<ActiveSessionType | null>;
  isReadOnly: PrimitiveAtom<boolean>;
  /** Agent lifecycle status; `error` stands for a failed open. */
  agentStatus: PrimitiveAtom<AgentStatus>;
};

type FakeManager = RaiseSeeds & {
  manager: NeedsInputSessionManager;
  switchSession: ReturnType<typeof vi.fn>;
  respondToPermission: ReturnType<typeof vi.fn>;
  answerQuestion: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
};

/**
 * Fake manager over real jotai atoms in a real store: the entry point reads the
 * raise through `store.get(atom)`, so the fake has to write the same atoms the
 * app's manager writes. The spies are returned beside the manager so assertions
 * never reference a method off the manager type.
 */
function createFakeManager(options?: {
  respondToPermission?: (requestId: string, response: 'once') => Promise<void>;
  answerQuestion?: (requestId: string, answers: string[][]) => Promise<void>;
  onSwitch?: (seeds: RaiseSeeds) => void;
  store?: ReturnType<typeof createStore>;
}): FakeManager {
  const store = options?.store ?? createStore();
  const activePermission = atom<PendingRequest | null>(null);
  const activeQuestion = atom<PendingRequest | null>(null);
  // `connecting` is the app-closed cold start the module must treat as
  // unknown; a test that has a snapshot lands it with `type: 'idle'`. The
  // other three atoms default to the live remote session the snapshot belongs
  // to; a test drives the read-only / failed-open cases by overriding them.
  const activity = atom<SessionActivity>({ type: 'connecting' });
  const sessionType = atom<ActiveSessionType | null>('remote');
  const isReadOnly = atom(false);
  const agentStatus = atom<AgentStatus>({ type: 'idle' });
  const seeds: RaiseSeeds = {
    store,
    activePermission,
    activeQuestion,
    activity,
    sessionType,
    isReadOnly,
    agentStatus,
  };
  const switchSession = vi.fn(async () => {
    options?.onSwitch?.(seeds);
  });
  const respondToPermission = vi.fn(options?.respondToPermission ?? (async () => undefined));
  const answerQuestion = vi.fn(options?.answerQuestion ?? (async () => undefined));
  const destroy = vi.fn<() => void>();
  const manager: NeedsInputSessionManager = {
    switchSession,
    respondToPermission,
    answerQuestion,
    destroy,
    atoms: { activePermission, activeQuestion, activity, sessionType, isReadOnly, agentStatus },
  };
  return { ...seeds, manager, switchSession, respondToPermission, answerQuestion, destroy };
}

/** Fake clock: `sleep` advances `now`, so every bounded wait settles at once. */
function createFakeClock() {
  let current = 0;
  return {
    now: () => current,
    sleep: async (ms: number) => {
      current += ms;
    },
    advance: (ms: number) => {
      current += ms;
    },
  };
}

function trpcError(code: string): Error {
  return Object.assign(new Error(code), { data: { code } });
}

const WAIT_BUDGET_MS = 300;
const POLL_INTERVAL_MS = 100;

/** Deps shared by every test that drives a fake manager on the fake clock. */
function fakeManagerDeps(
  fake: FakeManager,
  extra?: { ack?: (kiloSessionId: string) => void }
): NonNullable<Parameters<typeof runNeedsInputInteraction>[0]['deps']> {
  const clock = createFakeClock();
  return {
    createManager: () => fake.manager,
    store: fake.store,
    ...extra,
    now: clock.now,
    sleep: clock.sleep,
    waitBudgetMs: WAIT_BUDGET_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    // One settle poll keeps the settle loop's shape on the fake clock.
    missingRaiseSettleMs: POLL_INTERVAL_MS,
  };
}

describe('runNeedsInputInteraction', () => {
  beforeEach(() => {
    getSessionQuery.mockReset();
    createWebTicketMutate.mockReset();
    readStoredValueMock.mockReset();
    readStoredValueMock.mockResolvedValue('user-1');
    getSessionQuery.mockResolvedValue({ organization_id: 'org-1' });
    createMobileAgentSessionManagerMock.mockReset();
    createUserWebConnectionMock.mockReset();
  });

  describe('happy path', () => {
    it('approves the pending permission through the manager and acks attention', async () => {
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activePermission, { requestId: 'perm-1' });
        },
      });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('ok');
      expect(fake.switchSession).toHaveBeenCalledWith(SESSION_ID);
      expect(fake.respondToPermission).toHaveBeenCalledWith('perm-1', 'once');
      expect(fake.answerQuestion).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(SESSION_ID);
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('answers the pending question with the typed reply text', async () => {
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activeQuestion, { requestId: 'question-1' });
        },
      });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'reply',
        text: 'use the second option',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('ok');
      expect(fake.answerQuestion).toHaveBeenCalledWith('question-1', [['use the second option']]);
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(SESSION_ID);
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('passes existence, organization scope and user id into the manager factory', async () => {
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activePermission, { requestId: 'perm-2' });
        },
      });
      const createManager = vi.fn(() => fake.manager);

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: {
          ...fakeManagerDeps(fake),
          getSession: async () => ({ organization_id: 'org-42' }),
          getUserId: async () => 'user-42',
          createManager,
        },
      });

      expect(outcome).toBe('ok');
      expect(createManager).toHaveBeenCalledWith({
        store: fake.store,
        organizationId: 'org-42',
        userId: 'user-42',
      });
    });

    it('keeps waiting inside the budget for a raise that arrives late', async () => {
      const fake = createFakeManager();
      const clock = createFakeClock();
      let seeded = false;

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'reply',
        text: 'late answer',
        deps: {
          createManager: () => fake.manager,
          store: fake.store,
          now: clock.now,
          sleep: async ms => {
            clock.advance(ms);
            if (!seeded) {
              seeded = true;
              fake.store.set(fake.activeQuestion, { requestId: 'question-late' });
            }
          },
          waitBudgetMs: WAIT_BUDGET_MS,
          pollIntervalMs: POLL_INTERVAL_MS,
        },
      });

      expect(outcome).toBe('ok');
      expect(fake.answerQuestion).toHaveBeenCalledWith('question-late', [['late answer']]);
    });

    it('looks the session up through cliSessionsV2.get and reads the stored user id', async () => {
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activePermission, { requestId: 'perm-3' });
        },
      });
      const createManager = vi.fn(() => fake.manager);

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: { ...fakeManagerDeps(fake), createManager },
      });

      expect(outcome).toBe('ok');
      expect(getSessionQuery).toHaveBeenCalledWith({ session_id: SESSION_ID });
      expect(readStoredValueMock).toHaveBeenCalledWith('active-user-id');
      expect(createManager).toHaveBeenCalledWith({
        store: fake.store,
        organizationId: 'org-1',
        userId: 'user-1',
      });
    });

    it('builds the app mobile manager over the native user-web connection and mints its ticket', async () => {
      const store = createStore();
      const captured: { connection: UserWebConnectionOptions | null } = { connection: null };
      const fake = createFakeManager({
        store,
        onSwitch: seeds => {
          seeds.store.set(seeds.activePermission, { requestId: 'perm-9' });
        },
      });
      createUserWebConnectionMock.mockImplementation(options => {
        captured.connection = options;
        return {};
      });
      createMobileAgentSessionManagerMock.mockImplementation(() => fake.manager);
      createWebTicketMutate.mockResolvedValue({ token: 'ticket-9' });
      const clock = createFakeClock();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: {
          store,
          now: clock.now,
          sleep: clock.sleep,
          waitBudgetMs: WAIT_BUDGET_MS,
          pollIntervalMs: POLL_INTERVAL_MS,
        },
      });

      expect(outcome).toBe('ok');
      expect(createUserWebConnectionMock).toHaveBeenCalledWith(
        expect.objectContaining({ websocketUrl: 'wss://ingest.test/api/user/web' })
      );
      expect(createMobileAgentSessionManagerMock).toHaveBeenCalledWith({
        store,
        userWebConnection: {},
        organizationId: 'org-1',
        userId: 'user-1',
      });
      await expect(captured.connection?.getAuthToken()).resolves.toBe('ticket-9');
      expect(createWebTicketMutate).toHaveBeenCalledTimes(1);
    });
  });

  describe('retryable unhappy path', () => {
    it('returns retryable when approving fails on the transport, and does not ack', async () => {
      const fake = createFakeManager({
        respondToPermission: async () => {
          throw new Error('socket closed');
        },
        onSwitch: seeds => {
          seeds.store.set(seeds.activePermission, { requestId: 'perm-1' });
        },
      });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('retryable');
      expect(ack).not.toHaveBeenCalled();
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('returns retryable when replying fails on the transport', async () => {
      const fake = createFakeManager({
        answerQuestion: async () => {
          throw new Error('socket closed');
        },
        onSwitch: seeds => {
          seeds.store.set(seeds.activeQuestion, { requestId: 'question-1' });
        },
      });

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'reply',
        text: 'answer',
        deps: fakeManagerDeps(fake),
      });

      expect(outcome).toBe('retryable');
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('returns retryable when the session lookup fails without NOT_FOUND and never builds a manager', async () => {
      const createManager = vi.fn();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: {
          getSession: async () => {
            throw new Error('gateway timeout');
          },
          createManager,
        },
      });

      expect(outcome).toBe('retryable');
      expect(createManager).not.toHaveBeenCalled();
    });

    it('returns retryable when the manager cannot be created', async () => {
      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: {
          getSession: async () => ({ organization_id: 'org-1' }),
          getUserId: async () => 'user-1',
          createManager: () => {
            throw new Error('no native connection');
          },
        },
      });

      expect(outcome).toBe('retryable');
    });

    it('returns retryable when no raise of either kind appears in the budget, so the actions are kept', async () => {
      const fake = createFakeManager();
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      // An expired wait budget is not proof the raise is gone: a cold headless
      // start can exceed the budget while the raise is still live, so the
      // notification must keep its actions instead of turning terminal.
      expect(outcome).toBe('retryable');
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(fake.answerQuestion).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('returns retryable for a reply when neither kind is pending at the deadline', async () => {
      const fake = createFakeManager();
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'reply',
        text: 'answer',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('retryable');
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(fake.answerQuestion).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });
  });

  describe('non-retryable and empty paths', () => {
    it('returns unavailable for a stale session without building a manager', async () => {
      const createManager = vi.fn();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: {
          getSession: async () => {
            throw trpcError('NOT_FOUND');
          },
          createManager,
        },
      });

      expect(outcome).toBe('unavailable');
      expect(createManager).not.toHaveBeenCalled();
    });

    it('returns unavailable when cliSessionsV2.get reports the session is gone', async () => {
      const createManager = vi.fn();
      getSessionQuery.mockRejectedValue(trpcError('NOT_FOUND'));

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'reply',
        text: 'answer',
        deps: { createManager },
      });

      expect(outcome).toBe('unavailable');
      expect(createManager).not.toHaveBeenCalled();
    });

    it('returns unavailable when the connected snapshot reports no raise and the status moved on', async () => {
      // A raise answered elsewhere: the transport connected, the snapshot
      // cleared the pending sets and replayed whatever was still pending, and
      // the session's status has already left needs-input. An empty atom with
      // a moved-on status is authoritative — another tap can never succeed,
      // so the actions must go instead of looping the retry body.
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
        },
      });
      getSessionQuery.mockResolvedValue({ organization_id: 'org-1', status: 'idle' });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('unavailable');
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(fake.answerQuestion).not.toHaveBeenCalled();
      // The raise is over, so the Agents row and badge stop offering it.
      expect(ack).toHaveBeenCalledWith(SESSION_ID);
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('approves a still-raised raise the live snapshot proves has no ask, and acks attention', async () => {
      // A status-only raise: the notification was posted from the session's
      // needs-input status and no agent ever asked (or the ask is already
      // gone), but nobody answered the raise either. The proven-empty atoms
      // plus the still-raised status mean the user's approve is what ends the
      // raise — the outcome is the approved result, not a gone body and not a
      // retryable loop.
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
        },
      });
      getSessionQuery
        .mockResolvedValueOnce({ organization_id: 'org-1', status: 'permission' })
        .mockResolvedValue({ organization_id: 'org-1', status: 'permission' });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('ok');
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(fake.answerQuestion).not.toHaveBeenCalled();
      expect(ack).toHaveBeenCalledWith(SESSION_ID);
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('keeps a reply retryable when the raise is still raised but holds no question', async () => {
      // A reply ends nothing it did not answer: with the status still raised
      // the raise may be a permission the Approve control can still answer, so
      // the notification keeps its actions (wrong-kind tap contract).
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
        },
      });
      getSessionQuery.mockResolvedValue({ organization_id: 'org-1', status: 'permission' });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'reply',
        text: 'answer',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('retryable');
      expect(fake.answerQuestion).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('returns retryable when the outcome-time status read fails, so nothing terminal is announced', async () => {
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
        },
      });
      getSessionQuery
        .mockResolvedValueOnce({ organization_id: 'org-1' })
        .mockRejectedValue(
          Object.assign(new Error('network down'), { data: { code: 'INTERNAL_SERVER_ERROR' } })
        );
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('retryable');
      expect(ack).not.toHaveBeenCalled();
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('returns retryable when the session resolved read-only, so the empty atoms prove nothing', async () => {
      // A historical (read-only) resolution sets activity to idle without ever
      // opening a live socket: the absence of a raise is silence, not proof the
      // raise is gone, so the actions must survive (review finding: a read-only
      // resolution must never drop the Approve/Reply controls).
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
          seeds.store.set(seeds.sessionType, 'read-only');
          seeds.store.set(seeds.isReadOnly, true);
        },
      });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('retryable');
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
    });

    it('returns retryable when the live transport failed before its snapshot', async () => {
      // A resolved live session whose transport errors lands activity idle too,
      // so the status is what separates it from a landed snapshot.
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
          seeds.store.set(seeds.agentStatus, { type: 'error', message: 'transport failed' });
        },
      });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('retryable');
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
    });

    it('returns retryable when the resolve failed and left no transport kind', async () => {
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
          seeds.store.set(seeds.sessionType, null);
        },
      });
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('retryable');
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
    });

    it('returns retryable when a live transport opens but its socket never delivers a raise', async () => {
      // `connecting` is the never-opened socket: the budget expiring here is
      // exactly the cold headless start the raise can still be live behind.
      const fake = createFakeManager();
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(fake, { ack }),
      });

      expect(outcome).toBe('retryable');
      expect(ack).not.toHaveBeenCalled();
    });

    it('acks a session the user can no longer see', async () => {
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: {
          getSession: async () => {
            throw trpcError('NOT_FOUND');
          },
          ack,
        },
      });

      expect(outcome).toBe('unavailable');
      expect(ack).toHaveBeenCalledWith(SESSION_ID);
    });

    it('answers a raise that lands with the snapshot replay just after the budget', async () => {
      // The pending-ask replay follows the snapshot as its own events, so a
      // connected snapshot with nothing pending gets one more poll interval
      // before the absence is treated as terminal.
      const fake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
        },
      });
      const clock = createFakeClock();
      let seeded = false;
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: {
          createManager: () => fake.manager,
          store: fake.store,
          ack,
          now: clock.now,
          sleep: async ms => {
            clock.advance(ms);
            if (!seeded && clock.now() > WAIT_BUDGET_MS) {
              seeded = true;
              fake.store.set(fake.activePermission, { requestId: 'perm-late' });
            }
          },
          waitBudgetMs: WAIT_BUDGET_MS,
          pollIntervalMs: POLL_INTERVAL_MS,
        },
      });

      expect(outcome).toBe('ok');
      expect(fake.respondToPermission).toHaveBeenCalledWith('perm-late', 'once');
      expect(ack).toHaveBeenCalledWith(SESSION_ID);
    });

    it('returns retryable when the raise does not match the action, so the raise keeps its actions', async () => {
      // The connected snapshot holds the other kind: the wrong-kind tap must
      // not end a live raise the other action can still answer (c2), so this
      // stays retryable even though the transport reported its snapshot.
      const approveFake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
          seeds.store.set(seeds.activeQuestion, { requestId: 'question-1' });
        },
      });
      const replyFake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activity, { type: 'idle' });
          seeds.store.set(seeds.activePermission, { requestId: 'perm-1' });
        },
      });
      const approveAck = vi.fn<(kiloSessionId: string) => void>();
      const replyAck = vi.fn<(kiloSessionId: string) => void>();

      const approveOnQuestion = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: fakeManagerDeps(approveFake, { ack: approveAck }),
      });
      const replyOnPermission = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'reply',
        text: 'answer',
        deps: fakeManagerDeps(replyFake, { ack: replyAck }),
      });

      expect(approveOnQuestion).toBe('retryable');
      expect(approveFake.respondToPermission).not.toHaveBeenCalled();
      expect(approveAck).not.toHaveBeenCalled();
      expect(replyOnPermission).toBe('retryable');
      expect(replyFake.answerQuestion).not.toHaveBeenCalled();
      expect(replyAck).not.toHaveBeenCalled();
    });

    it('returns retryable when only the opposite kind is pending at the deadline, and sends nothing', async () => {
      const fake = createFakeManager();
      const clock = createFakeClock();
      let seeded = false;
      const ack = vi.fn<(kiloSessionId: string) => void>();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'approve',
        deps: {
          createManager: () => fake.manager,
          store: fake.store,
          ack,
          now: clock.now,
          sleep: async ms => {
            clock.advance(ms);
            if (!seeded) {
              seeded = true;
              fake.store.set(fake.activeQuestion, { requestId: 'question-late' });
            }
          },
          waitBudgetMs: WAIT_BUDGET_MS,
          pollIntervalMs: POLL_INTERVAL_MS,
        },
      });

      expect(outcome).toBe('retryable');
      expect(fake.respondToPermission).not.toHaveBeenCalled();
      expect(fake.answerQuestion).not.toHaveBeenCalled();
      expect(ack).not.toHaveBeenCalled();
      expect(fake.destroy).toHaveBeenCalledTimes(1);
    });

    it('returns retryable for a reply with no answer text, before building a manager', async () => {
      const createManager = vi.fn();

      const outcome = await runNeedsInputInteraction({
        kiloSessionId: SESSION_ID,
        action: 'reply',
        text: '   ',
        deps: { createManager },
      });

      expect(outcome).toBe('retryable');
      expect(createManager).not.toHaveBeenCalled();
    });
  });
});
