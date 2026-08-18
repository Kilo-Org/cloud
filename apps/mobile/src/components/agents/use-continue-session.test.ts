/* eslint-disable import/first -- mocks must be defined before the module under test is imported */
/* eslint-disable max-lines -- the suite pins both key families (cloud prepare + remote spawn) through one fake-dispatcher runner. */
import * as React from 'react';
import { atom, type createStore } from 'jotai';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

type JotaiStore = ReturnType<typeof createStore>;

// P1-A-08b: `useContinueSession` keeps TWO hoisted operation keys — one per
// destination family. Cloud prepares and remote spawns are different
// intents, so they never share a key; each is kept across retryable
// failures (so the ledger/relay dedupes the same-key retry) and rotated on
// success or a typed terminal rejection. This suite pins both families
// through a fake React dispatcher, mocking only the outside world.
//
// Destination resolution is deliberately mocked: this suite tests KEY
// WIRING, not `resolveContinuationDestinations` (which has its own module).

const prepareSessionMutate = vi.hoisted(() => vi.fn());
const remoteSpawnMock = vi.hoisted(() =>
  vi.fn(
    // eslint-disable-next-line require-await, typescript-eslint/require-await -- mock returns a settled outcome without awaiting
    async (
      _connectionId: string,
      _opts?: unknown,
      _options?: unknown
    ): Promise<CreateSessionOutcome> => ({
      status: 'retryable',
      reason: 'Connection destroyed',
      cause: new Error('Connection destroyed'),
    })
  )
);
const routerPush = vi.hoisted(() => vi.fn());
const queryClientFetchQuery = vi.hoisted(() => vi.fn());
const showActionSheetWithOptions = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
// Post-success side effects; tests reject them to pin the containment
// boundary around the successful cloud prepare.
const invalidateAgentSessionQueriesMock = vi.hoisted(() => vi.fn());
// Not a `vi.fn()`: vitest attaches its own rejection handler to any promise a
// mock returns, which would mask a leaked haptics rejection. A plain module
// export returning a real promise keeps `unhandledRejection` detection honest.
const hapticsMock = vi.hoisted(() => ({
  calls: 0,
  rejectWith: undefined as Error | undefined,
}));
// Destination list handed back by the mocked resolver; each test sets the
// single destination the continue flow should execute against.
const destinationsRef = vi.hoisted(() => ({ value: [] as unknown[] }));
// Lazy jotai store: `useStore()` returns one store for the whole suite and
// `store.get(manager.atoms.*)` reads the atoms' seeded initial values.
const storeRef = vi.hoisted(() => ({
  current: undefined as JotaiStore | undefined,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ fetchQuery: queryClientFetchQuery }),
}));
vi.mock('jotai', async importOriginal => {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- namespace type for the real jotai module under vi.mock
  const actual = await importOriginal<typeof import('jotai')>();
  return {
    ...actual,
    useStore: () => {
      storeRef.current ??= actual.createStore();
      return storeRef.current;
    },
  };
});
vi.mock('@expo/react-native-action-sheet', () => ({
  useActionSheet: () => ({ showActionSheetWithOptions }),
}));
vi.mock('@kilocode/cloud-agent-sdk/message-id', () => ({
  generateMessageId: () => 'msg-1',
}));
vi.mock('expo-haptics', () => ({
  notificationAsync: async (): Promise<void> => {
    hapticsMock.calls += 1;
    await Promise.resolve();
    if (hapticsMock.rejectWith !== undefined) {
      throw hapticsMock.rejectWith;
    }
  },
  NotificationFeedbackType: { Success: 'success' },
}));
vi.mock('sonner-native', () => ({
  toast: { error: toastError },
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  SESSION_CREATED_EVENT: 'session_created',
}));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries: invalidateAgentSessionQueriesMock,
}));
vi.mock('@/lib/share-payload', () => ({
  putSharePayload: () => 'share-1',
}));
vi.mock('@/lib/share-navigation', () => ({
  appendShareParams: (base: string) => base,
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } },
    organizations: { cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } } },
  },
  useTRPC: () => ({
    cloudAgentNext: {
      listGitHubRepositories: { queryOptions: () => ({ queryKey: ['repositories'] }) },
    },
    organizations: {
      cloudAgentNext: {
        listGitHubRepositories: { queryOptions: () => ({ queryKey: ['repositories'] }) },
      },
    },
    activeSessions: { listInstances: { queryOptions: () => ({ queryKey: ['instances'] }) } },
  }),
}));
// The real classifier lives in mobile-session-manager (covered by its own
// suite); this test only needs the retryable/non-retryable split.
vi.mock('@/components/agents/mobile-session-manager', () => ({
  isCloudPrepareRetryableError: (error: unknown) => {
    const record = error as { data?: { code?: string }; message?: string };
    return record.data?.code === 'CONFLICT' && record.message === 'creation_in_progress';
  },
}));
vi.mock('@/components/agents/mode-options', () => ({
  normalizeAgentMode: (mode: string | null | undefined) =>
    mode === 'code' ||
    mode === 'plan' ||
    mode === 'debug' ||
    mode === 'orchestrator' ||
    mode === 'ask'
      ? mode
      : 'code',
}));
vi.mock('@/components/agents/new-session-prefill', () => ({
  appendNewSessionPrefill: (base: string) => base,
  buildContinuePrefillParams: () => ({}),
}));
// The real continuation-seed module pulls in mode-options -> lucide-react-native
// (RN tree); this suite pins key wiring, so the builders are test hooks.
vi.mock('@/components/agents/continuation-seed', () => ({
  buildContinuationSeed: () => 'seed-text',
  buildContinueRemoteSpawnInput: () => undefined,
  resolveContinuationDestinations: () => destinationsRef.value,
}));
vi.mock('@/components/agents/user-web-connection-provider', () => ({
  useUserWebConnection: () => ({}),
}));
// Keep the real input builder; only stub the RN-touching spawn hook. The
// builder is imported from the pure classifier module — the hook module
// itself pulls in react-native via `useUserWebConnection` and cannot load
// under the plain Node vitest environment (see the classifier's header).
vi.mock('@/lib/hooks/use-remote-instance-spawn', () => ({
  buildCreateRemoteSessionInput,
  useRemoteInstanceSpawn: () => ({ spawn: remoteSpawnMock }),
}));
vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `op-key-${n}`;
    },
  };
});

// P1-E-40c: the continue path persists a safe-retry row and reuses a stored
// key on relaunch; the outbox is mocked so the fake dispatcher never runs its
// `useEffect` load.
const outboxMock = vi.hoisted(() => ({
  getStoredOperationKey: vi.fn(),
  writeSafeRetry: vi.fn(),
  remove: vi.fn(),
  whenLoaded: vi.fn(),
}));

vi.mock('@/lib/persist/use-mutation-outbox', () => ({
  useMutationOutbox: () => outboxMock,
}));

// The pure input builder must be imported BEFORE the module under test: the
// mocked `use-remote-instance-spawn` factory reads this binding when
// `use-continue-session.ts` loads it.
import {
  buildCreateRemoteSessionInput,
  type CreateSessionOutcome,
} from '@/lib/hooks/remote-instance-spawn-classifier';
import { useContinueSession } from './use-continue-session';

function creationInProgressError(): Error {
  return Object.assign(new Error('creation_in_progress'), { data: { code: 'CONFLICT' } });
}

function badRequestError(): Error {
  return Object.assign(new Error('session_creation_failed'), { data: { code: 'BAD_REQUEST' } });
}

function retryableOutcome() {
  return {
    status: 'retryable' as const,
    reason: 'Connection destroyed',
    cause: new Error('Connection destroyed'),
  };
}

function readyOutcome(): CreateSessionOutcome {
  return {
    status: 'ready',
    sessionID: 'ses_12345678901234567890123456' as KiloSessionId,
  };
}

function nonRetryableOutcome() {
  return {
    status: 'nonRetryable' as const,
    reason: 'CLI_UPGRADE_REQUIRED',
    cause: new Error('CLI_UPGRADE_REQUIRED'),
  };
}

// Fake manager over real jotai atoms; the store's `get` reads the seeded
// initial values, so `hasOlderMessages` stays false and the drain loop is a
// no-op while `messagesList` is non-empty for the seed builder.
const hasOlderMessagesAtom = atom(false);
const messagesListAtom = atom([
  { info: { role: 'user' }, parts: [{ type: 'text', text: 'hello' }] },
]);
const manager = {
  atoms: { hasOlderMessages: hasOlderMessagesAtom, messagesList: messagesListAtom },
  // eslint-disable-next-line no-empty-function -- seeded atoms keep the drain loop a no-op
  loadOlderMessages: async () => {},
};

type ReactInternals = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: unknown;
  };
};

type HookDispatcher = {
  useCallback: <T>(callback: T, _deps?: unknown) => T;
  useRef: <T>(initial: T) => { current: T };
  useState: <T>(initialValue: T) => [T, (value: T | ((previous: T) => T)) => void];
};

type ContinueSessionResult = ReturnType<typeof useContinueSession>;

function runContinueSession(args: {
  organizationId?: string;
  models?: SessionModelOption[];
}): ContinueSessionResult {
  const reactInternals = React as typeof React & ReactInternals;
  const hookState: unknown[] = [];
  const refs: { current: unknown }[] = [];
  let hookIndex = 0;
  let refIndex = 0;

  const dispatcher: HookDispatcher = {
    useCallback: hookCallback => {
      hookIndex += 1;
      return hookCallback;
    },
    useRef: initial => {
      const index = refIndex;
      refIndex += 1;
      refs[index] ??= { current: initial };
      return refs[index] as { current: typeof initial };
    },
    useState: initialValue => {
      const stateIndex = hookIndex;
      hookIndex += 1;
      if (hookState[stateIndex] === undefined) {
        hookState[stateIndex] = initialValue;
      }
      const setState = (
        value: typeof initialValue | ((previous: typeof initialValue) => typeof initialValue)
      ) => {
        hookState[stateIndex] =
          typeof value === 'function'
            ? (value as (previous: typeof initialValue) => typeof initialValue)(
                hookState[stateIndex] as typeof initialValue
              )
            : value;
      };
      return [hookState[stateIndex] as typeof initialValue, setState];
    },
  };

  const previousDispatcher =
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
  reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- fake dispatcher drives the hook in a plain vitest run
    return useContinueSession({
      organizationId: args.organizationId,
      manager: manager as never,
      models: args.models ?? [],
      modelsLoading: false,
    });
  } finally {
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
      previousDispatcher;
  }
}

const CLOUD_DESTINATION = {
  kind: 'cloud-agent',
  repo: 'owner/repo',
  model: 'model-1',
  variant: 'v1',
};
const REMOTE_DESTINATION = {
  kind: 'remote',
  instance: { connectionId: 'conn-1', name: 'laptop', projectName: 'kilo' },
};
const FIELDS = { gitUrl: null, mode: 'code', model: 'model-1', variant: 'v1' };

function usedCloudKeys(): (string | undefined)[] {
  return prepareSessionMutate.mock.calls.map(
    call => (call[0] as { operationKey?: string }).operationKey
  );
}

function usedRemoteKeys(): (string | undefined)[] {
  return remoteSpawnMock.mock.calls.map(
    call => (call[2] as { operationKey?: string } | undefined)?.operationKey
  );
}

describe('useContinueSession cloud operationKey', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    remoteSpawnMock.mockReset();
    routerPush.mockClear();
    queryClientFetchQuery.mockReset();
    toastError.mockClear();
    invalidateAgentSessionQueriesMock.mockReset();
    hapticsMock.calls = 0;
    hapticsMock.rejectWith = undefined;
    destinationsRef.value = [CLOUD_DESTINATION];
    // fetchQuery: first call is the repositories query, second the instances
    // query (Promise.all preserves call order). Both must resolve for the
    // destination resolution step to proceed.
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    queryClientFetchQuery.mockImplementation((options: { queryKey?: string[] }) => {
      if (options.queryKey?.[0] === 'instances') {
        return Promise.resolve({ instances: [] });
      }
      return Promise.resolve({ repositories: [] });
    });
  });

  it('keeps the same cloud operationKey across retryable creation_in_progress failures', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockRejectedValueOnce(creationInProgressError())
      .mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);
    await hook.continueSession(FIELDS);

    const keys = usedCloudKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'seed-text',
      githubRepo: 'owner/repo',
      autoCommit: false,
      autoInitiate: true,
      operationKey: expect.any(String),
    });
  });

  it('rotates the cloud operationKey after a successful prepare', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' })
      .mockRejectedValueOnce(creationInProgressError());
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);
    await hook.continueSession(FIELDS);
    await hook.continueSession(FIELDS);

    const keys = usedCloudKeys();
    // The successful retry rides the same key as the retryable attempt.
    expect(keys[1]).toBe(keys[0]);
    // The submit after success is a fresh intent with a fresh key.
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('rotates the cloud operationKey after a typed non-retryable rejection', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(badRequestError())
      .mockRejectedValueOnce(creationInProgressError());
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);
    await hook.continueSession(FIELDS);

    const keys = usedCloudKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe('useContinueSession post-success failure containment', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    remoteSpawnMock.mockReset();
    routerPush.mockClear();
    queryClientFetchQuery.mockReset();
    toastError.mockClear();
    invalidateAgentSessionQueriesMock.mockReset();
    hapticsMock.calls = 0;
    hapticsMock.rejectWith = undefined;
    destinationsRef.value = [CLOUD_DESTINATION];
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    queryClientFetchQuery.mockImplementation((options: { queryKey?: string[] }) => {
      if (options.queryKey?.[0] === 'instances') {
        return Promise.resolve({ instances: [] });
      }
      return Promise.resolve({ repositories: [] });
    });
  });

  it('still navigates and shows no create-failure toast when cache invalidation fails', async () => {
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    invalidateAgentSessionQueriesMock.mockRejectedValueOnce(new Error('cache invalidation failed'));
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);

    // The cloud prepare succeeded; the cache failure must not block
    // navigation and must not surface as a create failure.
    expect(routerPush).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('still navigates and shows no create-failure toast when haptics rejects', async () => {
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    hapticsMock.rejectWith = new Error('haptics unavailable');
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const hook = runContinueSession({ organizationId: 'org-1' });
      await hook.continueSession(FIELDS);
      // Give the runtime a turn to flag an unhandled rejection if the hook
      // ever leaks the haptics promise's rejection.
      await new Promise(resolve => {
        setImmediate(resolve);
      });

      // The rejected haptics call is contained: no unhandled rejection, no
      // create-failure toast, and the navigation still runs.
      expect(hapticsMock.calls).toBe(1);
      expect(routerPush).toHaveBeenCalledTimes(1);
      expect(toastError).not.toHaveBeenCalled();
      expect(unhandledRejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });
});

describe('useContinueSession remote operationKey', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    remoteSpawnMock.mockReset();
    routerPush.mockClear();
    queryClientFetchQuery.mockReset();
    toastError.mockClear();
    destinationsRef.value = [REMOTE_DESTINATION];
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    queryClientFetchQuery.mockImplementation((options: { queryKey?: string[] }) => {
      if (options.queryKey?.[0] === 'instances') {
        return Promise.resolve({ instances: [] });
      }
      return Promise.resolve({ repositories: [] });
    });
  });

  it('keeps the same remote operationKey across retryable spawn outcomes', async () => {
    remoteSpawnMock.mockResolvedValue(retryableOutcome());
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession({ gitUrl: null, mode: 'code', model: '', variant: '' });
    await hook.continueSession({ gitUrl: null, mode: 'code', model: '', variant: '' });

    const keys = usedRemoteKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    // The operationKey rides the third spawn argument (dedupe mutationId).
    expect(remoteSpawnMock.mock.calls[0]?.[0]).toBe('conn-1');
    expect(remoteSpawnMock.mock.calls[0]?.[2]).toMatchObject({ operationKey: expect.any(String) });
  });

  it('rotates the remote operationKey after a ready spawn', async () => {
    remoteSpawnMock
      .mockResolvedValueOnce(retryableOutcome())
      .mockResolvedValueOnce(readyOutcome())
      .mockResolvedValueOnce(retryableOutcome());
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession({ gitUrl: null, mode: 'code', model: '', variant: '' });
    await hook.continueSession({ gitUrl: null, mode: 'code', model: '', variant: '' });
    await hook.continueSession({ gitUrl: null, mode: 'code', model: '', variant: '' });

    const keys = usedRemoteKeys();
    // The ready attempt rides the key from the retryable attempt.
    expect(keys[1]).toBe(keys[0]);
    // The spawn after ready is a fresh intent with a fresh key.
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('rotates the remote operationKey after a typed non-retryable spawn rejection', async () => {
    remoteSpawnMock
      .mockResolvedValueOnce(nonRetryableOutcome())
      .mockResolvedValueOnce(retryableOutcome());
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession({ gitUrl: null, mode: 'code', model: '', variant: '' });
    await hook.continueSession({ gitUrl: null, mode: 'code', model: '', variant: '' });

    const keys = usedRemoteKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
  });
});

describe('useContinueSession key separation', () => {
  it('never shares a key between cloud prepares and remote spawns', async () => {
    prepareSessionMutate.mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    remoteSpawnMock.mockResolvedValueOnce(retryableOutcome());
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    queryClientFetchQuery.mockImplementation((options: { queryKey?: string[] }) => {
      if (options.queryKey?.[0] === 'instances') {
        return Promise.resolve({ instances: [] });
      }
      return Promise.resolve({ repositories: [] });
    });
    const hook = runContinueSession({ organizationId: 'org-1' });

    destinationsRef.value = [CLOUD_DESTINATION];
    await hook.continueSession(FIELDS);

    destinationsRef.value = [REMOTE_DESTINATION];
    await hook.continueSession({ gitUrl: null, mode: 'code', model: '', variant: '' });

    const cloudKey = usedCloudKeys()[0];
    const remoteKey = usedRemoteKeys()[0];
    expect(cloudKey).toBeDefined();
    expect(remoteKey).toBeDefined();
    expect(remoteKey).not.toBe(cloudKey);
  });
});

describe('useContinueSession cloud mutation outbox (P1-E-40c)', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    remoteSpawnMock.mockReset();
    routerPush.mockClear();
    queryClientFetchQuery.mockReset();
    toastError.mockClear();
    invalidateAgentSessionQueriesMock.mockReset();
    hapticsMock.calls = 0;
    hapticsMock.rejectWith = undefined;
    destinationsRef.value = [CLOUD_DESTINATION];
    outboxMock.getStoredOperationKey.mockReturnValue(null);
    outboxMock.writeSafeRetry.mockReset();
    outboxMock.writeSafeRetry.mockResolvedValue(undefined);
    outboxMock.remove.mockReset();
    outboxMock.remove.mockResolvedValue(undefined);
    outboxMock.whenLoaded.mockReset();
    outboxMock.whenLoaded.mockResolvedValue(undefined);
    // eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
    queryClientFetchQuery.mockImplementation((options: { queryKey?: string[] }) => {
      if (options.queryKey?.[0] === 'instances') {
        return Promise.resolve({ instances: [] });
      }
      return Promise.resolve({ repositories: [] });
    });
  });

  it('writes a safe-retry row before mutate and removes it on success', async () => {
    prepareSessionMutate.mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);

    expect(outboxMock.writeSafeRetry).toHaveBeenCalledTimes(1);
    expect(outboxMock.writeSafeRetry).toHaveBeenCalledWith(
      expect.objectContaining({
        operationKey: expect.any(String),
        fingerprint: expect.any(String),
      })
    );
    expect(outboxMock.remove).toHaveBeenCalledTimes(1);
    // The row is written before the mutate fires.
    expect(outboxMock.writeSafeRetry.mock.invocationCallOrder[0] ?? 0).toBeLessThan(
      prepareSessionMutate.mock.invocationCallOrder[0] ?? 0
    );
  });

  it('reuses a stored operationKey instead of minting a new UUID', async () => {
    outboxMock.getStoredOperationKey.mockReturnValue('stored-op-key');
    prepareSessionMutate.mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);

    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      operationKey: 'stored-op-key',
    });
  });

  it('awaits the outbox load before reading the stored key (no key-reuse race)', async () => {
    const order: string[] = [];
    outboxMock.whenLoaded.mockImplementation(() => {
      order.push('whenLoaded');
    });
    outboxMock.getStoredOperationKey.mockImplementation(() => {
      order.push('getStoredOperationKey');
      return 'stored-op-key';
    });
    prepareSessionMutate.mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);

    expect(order).toEqual(['whenLoaded', 'getStoredOperationKey']);
    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      operationKey: 'stored-op-key',
    });
  });

  it('keeps the row on a retryable failure so a relaunch reuses the key', async () => {
    prepareSessionMutate.mockRejectedValueOnce(creationInProgressError());
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);

    expect(outboxMock.remove).not.toHaveBeenCalled();
  });

  it('removes the row on a terminal failure', async () => {
    prepareSessionMutate.mockRejectedValueOnce(badRequestError());
    const hook = runContinueSession({ organizationId: 'org-1' });

    await hook.continueSession(FIELDS);

    expect(outboxMock.remove).toHaveBeenCalledTimes(1);
  });
});
