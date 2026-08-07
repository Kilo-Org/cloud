/* eslint-disable import/first -- mocks must be defined before the module under test is imported */
/* eslint-disable max-lines -- cohesive hook suite pinning the post-success containment regressions in one file */
import * as React from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// P1-A-08b: `useNewSessionCreator` must attach one stable `operationKey` per
// submit intent to `prepareSession`, keep it across retryable failures
// (incl. `creation_in_progress`), and rotate it on success or a typed
// non-retryable rejection. Run through a fake React dispatcher so the hook's
// own refs/callbacks are exercised without mounting React Native.

const prepareSessionMutate = vi.hoisted(() => vi.fn());
const routerPush = vi.hoisted(() => vi.fn());
const navigationDispatch = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const invalidateAgentSessionQueries = vi.hoisted(() => vi.fn());
// Not a `vi.fn()`: vitest attaches its own rejection handler to any promise a
// mock returns, which would mask a leaked haptics rejection. A plain module
// export returning a real promise keeps `unhandledRejection` detection honest.
const hapticsMock = vi.hoisted(() => ({
  calls: 0,
  rejectWith: undefined as Error | undefined,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: routerPush }),
  useNavigation: () => ({ dispatch: navigationDispatch }),
}));
vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
}));
vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } },
    organizations: { cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } } },
  },
  useTRPC: () => ({}),
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
vi.mock('@kilocode/cloud-agent-sdk/message-id', () => ({
  generateMessageId: () => 'msg-1',
}));
vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: vi.fn(),
  SESSION_CREATED_EVENT: 'session_created',
}));
vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries,
}));
// The real classifier lives in mobile-session-manager (covered by its own
// suite); this test mirrors its decision so hook-level retries are exercised
// for every retryable shape: no code (transport), CONFLICT +
// `creation_in_progress`, and the transient 5xx-class codes.
vi.mock('@/components/agents/mobile-session-manager', () => {
  const TRANSIENT_CODES = new Set([
    'INTERNAL_SERVER_ERROR',
    'BAD_GATEWAY',
    'SERVICE_UNAVAILABLE',
    'GATEWAY_TIMEOUT',
    'TIMEOUT',
    'TOO_MANY_REQUESTS',
  ]);
  return {
    isCloudPrepareRetryableError: (error: unknown) => {
      const record = error as { data?: { code?: string }; code?: string; message?: string };
      const code = record.data?.code ?? record.code;
      if (code === undefined) {
        return true;
      }
      if (code === 'CONFLICT') {
        return record.message === 'creation_in_progress';
      }
      return TRANSIENT_CODES.has(code);
    },
  };
});
vi.mock('expo-crypto', () => {
  let n = 0;
  return {
    randomUUID: () => {
      n += 1;
      return `op-key-${n}`;
    },
  };
});

import { useNewSessionCreator } from './use-new-session-creator';

// Simulated attachment wire payload (`{path, files}`). Each test sets this
// before a submit; the fake `toWirePayload` below reads it at call time so a
// test can change attachments between two submits.
let attachmentsWire: { path: string; files: string[] } | null = null;

function creationInProgressError(): Error {
  return Object.assign(new Error('creation_in_progress'), { data: { code: 'CONFLICT' } });
}

function badRequestError(): Error {
  return Object.assign(new Error('session_creation_failed'), { data: { code: 'BAD_REQUEST' } });
}

function transportError(): Error {
  return new Error('Network request failed');
}

function transient5xxError(): Error {
  return Object.assign(new Error('service unavailable'), { data: { code: 'SERVICE_UNAVAILABLE' } });
}

type ReactInternals = {
  __CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
    H: unknown;
  };
};

type HookDispatcher = {
  useCallback: <T>(callback: T, _deps?: unknown) => T;
  useRef: <T>(initial: T) => { current: T };
};

type CreatorResult = ReturnType<typeof useNewSessionCreator>;

function runCreator(args: {
  mode?: string;
  model?: string;
  variant?: string;
  organizationId?: string;
  selectedRepo?: string;
}): CreatorResult {
  const reactInternals = React as typeof React & ReactInternals;
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
  };

  const previousDispatcher =
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H;
  reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H = dispatcher;
  try {
    // eslint-disable-next-line react-hooks/rules-of-hooks -- fake dispatcher drives the hook in a plain vitest run
    return useNewSessionCreator({
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- attachment fake shape, never read by the create path
      attachments: {
        attachments: [],
        toWirePayload: () => attachmentsWire,
      } as never,
      mode: (args.mode ?? 'code') as never,
      model: args.model ?? 'model-1',
      organizationId: args.organizationId,
      selectedRepo: args.selectedRepo ?? 'owner/repo',
      // eslint-disable-next-line no-empty-function -- no-op state setter
      setIsCreating: () => {},
      variant: args.variant ?? 'v1',
    });
  } finally {
    reactInternals.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE.H =
      previousDispatcher;
  }
}

function usedOperationKeys(): (string | undefined)[] {
  return prepareSessionMutate.mock.calls.map(
    call => (call[0] as { operationKey?: string }).operationKey
  );
}

function sessionResult(): { kiloSessionId: string; cloudAgentSessionId: string } {
  return { kiloSessionId: 'ses_12345678901234567890123456', cloudAgentSessionId: 'c-1' };
}

describe('useNewSessionCreator operationKey', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    routerPush.mockClear();
    navigationDispatch.mockClear();
    toastError.mockClear();
    invalidateAgentSessionQueries.mockReset();
    hapticsMock.calls = 0;
    hapticsMock.rejectWith = undefined;
    attachmentsWire = null;
  });

  it('keeps the same operationKey across retryable creation_in_progress failures', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockRejectedValueOnce(creationInProgressError());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      prompt: 'hello',
      autoInitiate: true,
      operationKey: expect.any(String),
    });
  });

  it('rotates the operationKey after a success so the next submit is a fresh intent', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockResolvedValueOnce({
        kiloSessionId: 'ses_12345678901234567890123456',
        cloudAgentSessionId: 'c-1',
      })
      .mockRejectedValueOnce(creationInProgressError());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    await creator.createSessionFromDraft();
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    // The successful retry rides the same key as the retryable attempt.
    expect(keys[1]).toBe(keys[0]);
    // The submit after success is a fresh intent with a fresh key.
    expect(keys[2]).not.toBe(keys[0]);
  });

  it('keeps the same operationKey across a plain transport failure', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(transportError())
      .mockRejectedValueOnce(transportError());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[0]).toBeDefined();
    // A transport failure is ambiguous: the ledger may have accepted the
    // attempt, so the same-key retry lets it reconcile instead of spawning a
    // second session.
    expect(keys[1]).toBe(keys[0]);
  });

  it('keeps the same operationKey across a transient typed 5xx failure', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(transient5xxError())
      .mockRejectedValueOnce(transient5xxError());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
  });

  it('rotates the operationKey after a typed non-retryable rejection', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(badRequestError())
      .mockRejectedValueOnce(creationInProgressError());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('treats a changed draft as a new intent with a new key', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockRejectedValueOnce(creationInProgressError());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    creator.promptRef.current = 'hello, changed';
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('keeps the same operationKey across retryable failures when attachments are unchanged', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockRejectedValueOnce(creationInProgressError());
    const creator = runCreator({});
    attachmentsWire = { path: 'p-1', files: ['a-1'] };

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[0]).toBeDefined();
    expect(keys[1]).toBe(keys[0]);
    // The wire payload the fingerprint read is the payload the create body
    // carries, so the fingerprint and the mutation agree on the intent.
    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      attachments: { path: 'p-1', files: ['a-1'] },
    });
  });

  it('treats changed attachments as a new intent with a new key', async () => {
    prepareSessionMutate
      .mockRejectedValueOnce(creationInProgressError())
      .mockRejectedValueOnce(creationInProgressError());
    const creator = runCreator({});
    attachmentsWire = { path: 'p-1', files: ['a-1'] };

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    // The user swapped the attachment; the next submit is a fresh intent
    // with a fresh key, otherwise the same-key retry would replay the
    // previous intent's ledger result instead of creating with the new file.
    attachmentsWire = { path: 'p-1', files: ['a-2'] };
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('does not treat a post-success cache failure as a create failure and rotates the key', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    invalidateAgentSessionQueries.mockRejectedValueOnce(new Error('cache invalidation failed'));
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    // The create-failure toast path must not run for a post-success failure.
    expect(toastError).not.toHaveBeenCalled();

    // The next submit is a fresh intent with a fresh key, not a retry of the
    // successful operation key.
    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[1]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('does not treat a post-success navigation failure as a create failure and rotates the key', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    routerPush.mockImplementationOnce(() => {
      throw new Error('navigation failed');
    });
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();
    // The create-failure toast path must not run for a post-success failure.
    expect(toastError).not.toHaveBeenCalled();

    // The next submit is a fresh intent with a fresh key, not a retry of the
    // successful operation key.
    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    const keys = usedOperationKeys();
    expect(keys[1]).toBeDefined();
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('does not treat a rejected haptics call as a create failure and rotates the key', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    hapticsMock.rejectWith = new Error('haptics failed');
    const unhandledRejections: unknown[] = [];
    const onUnhandledRejection = (reason: unknown) => {
      unhandledRejections.push(reason);
    };
    process.on('unhandledRejection', onUnhandledRejection);

    try {
      const creator = runCreator({});
      creator.promptRef.current = 'hello';
      await creator.createSessionFromDraft();
      // Give the runtime a turn to flag an unhandled rejection if the hook
      // ever leaks the haptics promise's rejection.
      await new Promise(resolve => {
        setImmediate(resolve);
      });
      expect(hapticsMock.calls).toBe(1);
      // A rejected haptics call must be contained: no unhandled rejection and
      // no create-failure toast.
      expect(unhandledRejections).toEqual([]);
      expect(toastError).not.toHaveBeenCalled();

      // The next submit is a fresh intent with a fresh key, not a retry of the
      // successful operation key.
      creator.promptRef.current = 'hello';
      await creator.createSessionFromDraft();

      const keys = usedOperationKeys();
      expect(keys[1]).toBeDefined();
      expect(keys[1]).not.toBe(keys[0]);
    } finally {
      process.off('unhandledRejection', onUnhandledRejection);
    }
  });

  it('contains a deferred stack-cleanup failure after a success and rotates the key', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    navigationDispatch.mockImplementationOnce(() => {
      throw new Error('stack cleanup failed');
    });
    // The test environment has no requestAnimationFrame; capture the deferred
    // callback so it can be run after the submit settles, like the real frame
    // boundary does.
    const scheduledFrames: (() => void)[] = [];
    // eslint-disable-next-line promise/prefer-await-to-callbacks -- the arrow is a global stub, not an async callback
    vi.stubGlobal('requestAnimationFrame', (callback: () => void) => {
      scheduledFrames.push(callback);
      return 1;
    });

    try {
      const creator = runCreator({});
      creator.promptRef.current = 'hello';
      await creator.createSessionFromDraft();
      expect(toastError).not.toHaveBeenCalled();

      // The deferred stack cleanup runs after the submit returned; a failure
      // there must be contained instead of surfacing as an uncaught exception.
      expect(scheduledFrames).toHaveLength(1);
      expect(() => {
        scheduledFrames[0]?.();
      }).not.toThrow();
      expect(toastError).not.toHaveBeenCalled();

      // The next submit is a fresh intent with a fresh key, not a retry of the
      // successful operation key.
      creator.promptRef.current = 'hello';
      await creator.createSessionFromDraft();

      const keys = usedOperationKeys();
      expect(keys[1]).toBeDefined();
      expect(keys[1]).not.toBe(keys[0]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
