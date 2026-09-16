/* eslint-disable max-lines, require-await, @typescript-eslint/require-await -- one suite pins every notification-action outcome; the injectable fakes settle without await */
import { atom, createStore, type PrimitiveAtom } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
  secureStoreGetItemAsync,
  createMobileAgentSessionManagerMock,
  createUserWebConnectionMock,
} = vi.hoisted(() => ({
  getSessionQuery: vi.fn(),
  createWebTicketMutate: vi.fn(),
  secureStoreGetItemAsync: vi.fn(async () => 'user-1'),
  createMobileAgentSessionManagerMock: vi.fn(
    (_options: ManagerFactoryArgs): NeedsInputSessionManager => {
      throw new Error('createMobileAgentSessionManager not stubbed for this test');
    }
  ),
  createUserWebConnectionMock: vi.fn((_options: UserWebConnectionOptions) => ({})),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: secureStoreGetItemAsync,
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
  const seeds: RaiseSeeds = { store, activePermission, activeQuestion };
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
    atoms: { activePermission, activeQuestion },
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
  };
}

describe('runNeedsInputInteraction', () => {
  beforeEach(() => {
    getSessionQuery.mockReset();
    createWebTicketMutate.mockReset();
    secureStoreGetItemAsync.mockReset();
    secureStoreGetItemAsync.mockResolvedValue('user-1');
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
      expect(secureStoreGetItemAsync).toHaveBeenCalledWith('active-user-id');
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

    it('returns retryable when the raise does not match the action, so the raise keeps its actions', async () => {
      const approveFake = createFakeManager({
        onSwitch: seeds => {
          seeds.store.set(seeds.activeQuestion, { requestId: 'question-1' });
        },
      });
      const replyFake = createFakeManager({
        onSwitch: seeds => {
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
