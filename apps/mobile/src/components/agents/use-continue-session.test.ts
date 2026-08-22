/* eslint-disable import/first -- mocks must be defined before the module under test is imported */
/* eslint-disable require-await, typescript-eslint/require-await -- the fake outbox mocks settle without await because they resolve immediately */
/* eslint-disable max-lines -- the suite pins the cloud prepare key family, its containment, and the clone-source wiring through one fake-dispatcher runner. */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

// P1-A-08b: `useContinueSession` keeps ONE hoisted operation key for the
// cloud prepare. The key is kept across retryable failures (so the ledger
// dedupes the same-key retry) and rotated on success or a typed terminal
// rejection. The full clone is source-sensitive: the fingerprint carries the
// clone source id, so a different source never reuses the stored key.
//
// Destination resolution is deliberately mocked: this suite tests KEY
// WIRING, not `resolveContinuationResolution` (which has its own module).

const prepareSessionMutate = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const queryClientFetchQuery = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const putSharePayloadMock = vi.hoisted(() => vi.fn());
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
// Resolution handed back by the mocked resolver; each test sets the
// single cloud resolution the continue flow should execute against, or a
// failure kind that maps to terminal guidance.
const resolutionRef = vi.hoisted(() => ({ value: null as unknown }));
// Injected backoff sleep; tests assert the exact delay sequence.
const sleepMock = vi.hoisted(() =>
  vi.fn(async (_ms: number) => {
    void _ms;
  })
);

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ fetchQuery: queryClientFetchQuery }),
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
  putSharePayload: putSharePayloadMock,
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
vi.mock('@/components/agents/mode-normalize', () => ({
  normalizeAgentMode: (mode: string | null | undefined) => {
    if (mode === 'build') {
      return 'code';
    }
    if (mode === 'architect') {
      return 'plan';
    }
    if (!mode) {
      return 'code';
    }
    return mode;
  },
}));
// The real continuation-seed module pulls in mode-options -> lucide-react-native
// (RN tree); this suite pins key wiring, so the resolver is a test hook.
vi.mock('@/components/agents/continuation-seed', () => ({
  resolveContinuationResolution: () => resolutionRef.value,
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
  whenLoaded: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock('@/lib/persist/use-mutation-outbox', () => ({
  useMutationOutbox: () => outboxMock,
}));

import { useContinueSession } from './use-continue-session';

const SESSION_ID = 'ses_12345678901234567890123456' as KiloSessionId;
const OTHER_SESSION_ID = 'ses_abcdefghijklmnopqrstuvwxyz' as KiloSessionId;

function creationInProgressError(): Error {
  return Object.assign(new Error('creation_in_progress'), { data: { code: 'CONFLICT' } });
}

function badRequestError(): Error {
  return Object.assign(new Error('session_creation_failed'), { data: { code: 'BAD_REQUEST' } });
}

type ReactInternals = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: unknown;
  };
};

type HookDispatcher = {
  useCallback: <T>(callback: T, _deps?: unknown) => T;
  useRef: <T>(initial: T) => { current: T };
  useState: <T>(initialValue: T) => [T, (value: T | ((previous: T) => T)) => void];
  useEffect: (_effect: () => void, _deps?: unknown) => void;
};

type ContinueSessionResult = ReturnType<typeof useContinueSession>;

type ContinueSessionArgs = {
  sessionId?: KiloSessionId;
  organizationId?: string;
  models?: SessionModelOption[];
  modelsLoading?: boolean;
  sleep?: (ms: number) => Promise<void>;
};

type ContinueSessionMount = {
  result: ContinueSessionResult;
  rerender: (args?: ContinueSessionArgs) => ContinueSessionResult;
};

function mountContinueSession(args: ContinueSessionArgs): ContinueSessionMount {
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
    useEffect: () => {
      hookIndex += 1;
    },
  };

  const render = (renderArgs: ContinueSessionArgs): ContinueSessionResult => {
    hookIndex = 0;
    refIndex = 0;
    const previousDispatcher =
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
    try {
      // eslint-disable-next-line react-hooks/rules-of-hooks -- fake dispatcher drives the hook in a plain vitest run
      return useContinueSession({
        sessionId: renderArgs.sessionId ?? SESSION_ID,
        organizationId: renderArgs.organizationId,
        models: renderArgs.models ?? [],
        modelsLoading: renderArgs.modelsLoading ?? false,
        sleep: renderArgs.sleep ?? sleepMock,
      });
    } finally {
      reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
        previousDispatcher;
    }
  };

  const result = render(args);
  return {
    result,
    rerender: (nextArgs = args) => render(nextArgs),
  };
}

const CLOUD_RESOLUTION = {
  kind: 'cloud-agent',
  repo: 'owner/repo',
  model: 'model-1',
  variant: 'v1',
};
const FIELDS = { gitUrl: null, mode: 'code', model: 'model-1', variant: 'v1' };

function usedCloudKeys(): (string | undefined)[] {
  return prepareSessionMutate.mock.calls.map(
    call => (call[0] as { operationKey?: string }).operationKey
  );
}

function mockRepositories() {
  queryClientFetchQuery.mockImplementation(async () => ({ repositories: [] }));
}

describe('useContinueSession cloud clone wiring', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    routerPush.mockClear();
    queryClientFetchQuery.mockReset();
    toastError.mockClear();
    putSharePayloadMock.mockReset();
    invalidateAgentSessionQueriesMock.mockReset();
    hapticsMock.calls = 0;
    hapticsMock.rejectWith = undefined;
    resolutionRef.value = CLOUD_RESOLUTION;
    sleepMock.mockClear();
    outboxMock.getStoredOperationKey.mockReturnValue(null);
    outboxMock.writeSafeRetry.mockReset();
    outboxMock.writeSafeRetry.mockResolvedValue(undefined);
    outboxMock.remove.mockReset();
    outboxMock.remove.mockResolvedValue(undefined);
    outboxMock.whenLoaded.mockReset();
    outboxMock.whenLoaded.mockResolvedValue(true);
    mockRepositories();
  });

  it('forwards the clone-only input into prepareSession', async () => {
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const mount = mountContinueSession({ sessionId: SESSION_ID, organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    const input = prepareSessionMutate.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(input).toMatchObject({
      cloneFromKiloSessionId: SESSION_ID,
      autoInitiate: true,
      operationKey: expect.any(String),
      githubRepo: 'owner/repo',
    });
    expect(input.prompt).toBeUndefined();
    expect(input.initialMessageId).toBeUndefined();
  });

  it('never drains history and never queries instances: only the repository list is fetched', async () => {
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    const queryKeys = queryClientFetchQuery.mock.calls.map(
      call => (call[0] as { queryKey?: string[] }).queryKey
    );
    expect(queryClientFetchQuery).toHaveBeenCalledTimes(1);
    expect(queryKeys).toEqual([['repositories']]);
  });

  it('never writes a share payload', async () => {
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(putSharePayloadMock).not.toHaveBeenCalled();
  });

  it('retries up to six attempts reusing the same operationKey with the exact delays', async () => {
    prepareSessionMutate.mockRejectedValue(creationInProgressError());
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(prepareSessionMutate).toHaveBeenCalledTimes(6);
    const keys = usedCloudKeys();
    expect(keys).toHaveLength(6);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBeDefined();
    expect(sleepMock.mock.calls.map(call => call[0])).toEqual([500, 1000, 2000, 4000, 5000]);
  });

  it('reuses the same operationKey across user retries after a retryable failure', async () => {
    prepareSessionMutate.mockRejectedValue(creationInProgressError());
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);
    await mount.result.continueSession(FIELDS);

    const keys = usedCloudKeys();
    expect(keys).toHaveLength(12);
    expect(new Set(keys).size).toBe(1);
  });

  it('rotates the operationKey after a successful prepare', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' })
      .mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);
    await mount.result.continueSession(FIELDS);

    const keys = usedCloudKeys();
    // The successful retry rides the same key as the retryable attempt.
    expect(keys[1]).toBe(keys[0]);
    // The submit after success is a fresh intent with a fresh key.
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('rotates the operationKey after a terminal rejection', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(badRequestError())
      .mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);
    await mount.result.continueSession(FIELDS);

    const keys = usedCloudKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('mints a source-sensitive fingerprint so a different source never reuses the key', async () => {
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const mountA = mountContinueSession({ sessionId: SESSION_ID, organizationId: 'org-1' });
    const mountB = mountContinueSession({ sessionId: OTHER_SESSION_ID, organizationId: 'org-1' });

    await mountA.result.continueSession(FIELDS);
    await mountB.result.continueSession(FIELDS);

    const fingerprints = outboxMock.writeSafeRetry.mock.calls.map(
      call => (call[0] as { fingerprint?: string }).fingerprint
    );
    expect(fingerprints[0]).toContain(SESSION_ID);
    expect(fingerprints[1]).toContain(OTHER_SESSION_ID);
    expect(fingerprints[0]).not.toBe(fingerprints[1]);
  });

  it('reuses the same fingerprint across internal retries of the same source', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const mount = mountContinueSession({ sessionId: SESSION_ID, organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    const fingerprints = outboxMock.writeSafeRetry.mock.calls.map(
      call => (call[0] as { fingerprint?: string }).fingerprint
    );
    expect(fingerprints).toHaveLength(2);
    expect(fingerprints[0]).toBe(fingerprints[1]);
  });

  it('surfaces connect-repository guidance and does not navigate when the repository is unmatched', async () => {
    resolutionRef.value = { kind: 'unmatched-repository' };
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(mount.rerender().guidance).toEqual({
      kind: 'terminal',
      action: 'connect-repository',
      message: expect.any(String),
    });
    expect(routerPush).not.toHaveBeenCalled();
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('surfaces back-to-sessions guidance when the repository matches but the model is unresolved', async () => {
    resolutionRef.value = { kind: 'unresolved-model' };
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(mount.rerender().guidance).toEqual({
      kind: 'terminal',
      action: 'back-to-sessions',
      message: expect.any(String),
    });
    expect(routerPush).not.toHaveBeenCalled();
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('surfaces persistent retry guidance when the repository fetch fails', async () => {
    queryClientFetchQuery.mockRejectedValue(new Error('network'));
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(mount.rerender().guidance).toEqual({ kind: 'retry', message: expect.any(String) });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
  });

  it('clears guidance when clearGuidance is called', async () => {
    resolutionRef.value = { kind: 'unmatched-repository' };
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);
    expect(mount.rerender().guidance).not.toBeNull();

    mount.result.clearGuidance();
    expect(mount.rerender().guidance).toBeNull();
  });
});

describe('useContinueSession loading and guidance states', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    routerPush.mockClear();
    queryClientFetchQuery.mockReset();
    toastError.mockClear();
    invalidateAgentSessionQueriesMock.mockReset();
    hapticsMock.calls = 0;
    hapticsMock.rejectWith = undefined;
    resolutionRef.value = CLOUD_RESOLUTION;
    sleepMock.mockClear();
    outboxMock.getStoredOperationKey.mockReturnValue(null);
    outboxMock.writeSafeRetry.mockReset();
    outboxMock.writeSafeRetry.mockResolvedValue(undefined);
    outboxMock.remove.mockReset();
    outboxMock.remove.mockResolvedValue(undefined);
    outboxMock.whenLoaded.mockReset();
    outboxMock.whenLoaded.mockResolvedValue(true);
    mockRepositories();
  });

  it('sets isContinuing during the attempt and clears it after', async () => {
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    const mount = mountContinueSession({ organizationId: 'org-1' });

    const promise = mount.result.continueSession(FIELDS);
    // isContinuing is set synchronously before the first await.
    expect(mount.rerender().isContinuing).toBe(true);

    await promise;
    expect(mount.rerender().isContinuing).toBe(false);
  });

  it('re-enables Continue after the sixth retryable failure', async () => {
    prepareSessionMutate.mockRejectedValue(creationInProgressError());
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    const after = mount.rerender();
    expect(after.isContinuing).toBe(false);
    expect(after.guidance).toEqual({ kind: 'retry', message: expect.any(String) });
  });

  it('keeps Continue enabled with retry guidance while models are loading', async () => {
    const mount = mountContinueSession({ organizationId: 'org-1', modelsLoading: true });

    await mount.result.continueSession(FIELDS);

    const after = mount.rerender();
    expect(after.isContinuing).toBe(false);
    expect(after.guidance).toEqual({ kind: 'retry', message: expect.any(String) });
    expect(prepareSessionMutate).not.toHaveBeenCalled();
    expect(queryClientFetchQuery).not.toHaveBeenCalled();
  });

  it('surfaces persistent terminal guidance with the back-to-sessions action', async () => {
    prepareSessionMutate.mockRejectedValue(badRequestError());
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    const after = mount.rerender();
    expect(after.isContinuing).toBe(false);
    expect(after.guidance).toEqual({
      kind: 'terminal',
      action: 'back-to-sessions',
      message: expect.any(String),
    });
    expect(prepareSessionMutate).toHaveBeenCalledTimes(1);
  });

  it('never falls back to a partial clone: every attempt carries the clone source and no navigation happens', async () => {
    prepareSessionMutate.mockRejectedValue(creationInProgressError());
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(routerPush).not.toHaveBeenCalled();
    const inputs = prepareSessionMutate.mock.calls.map(call => call[0] as Record<string, unknown>);
    expect(inputs).toHaveLength(6);
    for (const input of inputs) {
      expect(input.cloneFromKiloSessionId).toBe(SESSION_ID);
      expect(input.prompt).toBeUndefined();
      expect(input.initialMessageId).toBeUndefined();
    }
  });
});

describe('useContinueSession post-success failure containment', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    routerPush.mockClear();
    queryClientFetchQuery.mockReset();
    toastError.mockClear();
    invalidateAgentSessionQueriesMock.mockReset();
    hapticsMock.calls = 0;
    hapticsMock.rejectWith = undefined;
    resolutionRef.value = CLOUD_RESOLUTION;
    sleepMock.mockClear();
    outboxMock.getStoredOperationKey.mockReturnValue(null);
    outboxMock.writeSafeRetry.mockReset();
    outboxMock.writeSafeRetry.mockResolvedValue(undefined);
    outboxMock.remove.mockReset();
    outboxMock.remove.mockResolvedValue(undefined);
    outboxMock.whenLoaded.mockReset();
    outboxMock.whenLoaded.mockResolvedValue(true);
    mockRepositories();
  });

  it('still navigates and shows no create-failure toast when cache invalidation fails', async () => {
    prepareSessionMutate.mockResolvedValueOnce({
      kiloSessionId: 'ses_12345678901234567890123456',
    });
    invalidateAgentSessionQueriesMock.mockRejectedValueOnce(new Error('cache invalidation failed'));
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

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
      const mount = mountContinueSession({ organizationId: 'org-1' });
      await mount.result.continueSession(FIELDS);
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

describe('useContinueSession cloud mutation outbox (P1-E-40c)', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    routerPush.mockClear();
    queryClientFetchQuery.mockReset();
    toastError.mockClear();
    invalidateAgentSessionQueriesMock.mockReset();
    hapticsMock.calls = 0;
    hapticsMock.rejectWith = undefined;
    resolutionRef.value = CLOUD_RESOLUTION;
    sleepMock.mockClear();
    outboxMock.getStoredOperationKey.mockReturnValue(null);
    outboxMock.writeSafeRetry.mockReset();
    outboxMock.writeSafeRetry.mockResolvedValue(undefined);
    outboxMock.remove.mockReset();
    outboxMock.remove.mockResolvedValue(undefined);
    outboxMock.whenLoaded.mockReset();
    outboxMock.whenLoaded.mockResolvedValue(true);
    mockRepositories();
  });

  it('writes a safe-retry row before mutate and removes it on success', async () => {
    prepareSessionMutate.mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

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
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      operationKey: 'stored-op-key',
    });
  });

  it('awaits the outbox load before reading the stored key (no key-reuse race)', async () => {
    const order: string[] = [];
    outboxMock.whenLoaded.mockImplementation(async () => {
      order.push('whenLoaded');
      await Promise.resolve();
      return true;
    });
    outboxMock.getStoredOperationKey.mockImplementation(() => {
      order.push('getStoredOperationKey');
      return 'stored-op-key';
    });
    prepareSessionMutate.mockResolvedValueOnce({ kiloSessionId: 'ses_12345678901234567890123456' });
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(order).toEqual(['whenLoaded', 'getStoredOperationKey']);
    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      operationKey: 'stored-op-key',
    });
  });

  it('keeps the row on retryable failures so a relaunch reuses the key', async () => {
    prepareSessionMutate.mockRejectedValue(creationInProgressError());
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(outboxMock.remove).not.toHaveBeenCalled();
  });

  it('removes the row on a terminal failure', async () => {
    prepareSessionMutate.mockRejectedValue(badRequestError());
    const mount = mountContinueSession({ organizationId: 'org-1' });

    await mount.result.continueSession(FIELDS);

    expect(outboxMock.remove).toHaveBeenCalledTimes(1);
  });
});
