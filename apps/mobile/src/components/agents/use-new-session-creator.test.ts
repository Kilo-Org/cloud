/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (node env, no jsdom); see src/lib/persist/cache-persistence-mount.test.ts */
/* eslint-disable require-await, @typescript-eslint/require-await -- the fake mutate factories settle without await because they resolve immediately */
/* eslint-disable max-lines -- the creator, operation-key, and generation-fenced draft-load suites share one mock harness in this file */
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type AgentMode } from '@/components/agents/mode-selector';
import { useNewSessionCreator } from './use-new-session-creator';
import { clearDraft, flushDraft, loadDraft } from '@/lib/persist/drafts';
import { useFencedDraftLoad, useRemoteSpawnDraftCleanup } from '@/lib/persist/use-draft-load';

const prepareSessionMutate = vi.hoisted(() => vi.fn());
const routerReplace = vi.hoisted(() => vi.fn());
const toastError = vi.hoisted(() => vi.fn());
const captureEventMock = vi.hoisted(() => vi.fn());
const invalidateAgentSessionQueries = vi.hoisted(() => vi.fn(async () => undefined));
// Not a `vi.fn()`: vitest attaches its own rejection handler to any promise a
// mock returns, which would mask a leaked haptics rejection. A plain module
// export returning a real promise keeps `unhandledRejection` detection honest.
const hapticsMock = vi.hoisted(() => ({
  calls: 0,
  rejectWith: undefined as Error | undefined,
}));

vi.mock('expo-router', () => ({
  useRouter: () => ({ replace: routerReplace }),
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({}),
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

vi.mock('@/lib/agent-session-cache', () => ({
  invalidateAgentSessionQueries,
}));

vi.mock('@/lib/analytics/posthog', () => ({
  captureEvent: captureEventMock,
  SESSION_CREATED_EVENT: 'session_created',
}));

vi.mock('@/lib/trpc', () => ({
  trpcClient: {
    cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } },
    organizations: { cloudAgentNext: { prepareSession: { mutate: prepareSessionMutate } } },
  },
  useTRPC: () => ({ mockTrpc: true }),
}));

vi.mock('@kilocode/cloud-agent-sdk/message-id', () => ({
  generateMessageId: () => 'msg_test',
}));

vi.mock('@/lib/persist/drafts', () => ({
  isStringDraft: vi.fn(),
  loadDraft: vi.fn(
    async (_userId: string, _entityKey: string, _isValid: unknown): Promise<string | null> => null
  ),
  NEW_SESSION_DRAFT_KEY: 'agent-composer:new',
  saveDraft: vi.fn(),
  flushDraft: vi.fn(async () => undefined),
  clearDraft: vi.fn(async () => undefined),
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

const outboxMock = vi.hoisted(() => ({
  getStoredOperationKey: vi.fn((_fingerprint: string): string | null => null),
  writeSafeRetry: vi.fn(async (): Promise<void> => undefined),
  remove: vi.fn(async (): Promise<void> => undefined),
  whenLoaded: vi.fn(async (): Promise<boolean> => true),
}));

vi.mock('@/lib/persist/use-mutation-outbox', () => ({
  useMutationOutbox: () => outboxMock,
}));

type CreatorInput = Parameters<typeof useNewSessionCreator>[0];
type CreatorResult = ReturnType<typeof useNewSessionCreator>;

// Simulated attachment wire payload (`{path, files}`). Each test sets this
// before a submit; the fake `uploadPending` below reads it at call time so a
// test can change attachments between two submits.
let attachmentsWire: { path: string; files: string[] } | null = null;

const FAKE_ATTACHMENTS: CreatorInput['attachments'] = {
  attachments: [],
  addCandidates: vi.fn(async () => undefined),
  removeAttachment: vi.fn(() => undefined),
  retryAttachment: vi.fn(() => undefined),
  reset: vi.fn(() => undefined),
  isUploading: false,
  hasFailedAttachments: false,
    uploadPending: vi.fn(async () => ({
      ok: true as const,
      wire: undefined,
      submission: undefined,
    })),
};

function createInput(overrides: Partial<CreatorInput> = {}): CreatorInput {
  return {
    attachments: FAKE_ATTACHMENTS,
    mode: 'code' as AgentMode,
    model: 'anthropic/claude-sonnet-4',
    organizationId: undefined,
    selectedRepo: '',
    setIsCreating: vi.fn(() => undefined),
    variant: 'medium',
    autoCommit: false,
    ...overrides,
  };
}

function Harness({
  input,
  resultRef,
}: {
  input: CreatorInput;
  resultRef: { current: CreatorResult | null };
}) {
  const result = useNewSessionCreator(input);
  resultRef.current = result;
  return null;
}

function mountCreator(input: CreatorInput) {
  const resultRef: { current: CreatorResult | null } = { current: null };
  act(() => {
    TestRenderer.create(React.createElement(Harness, { input, resultRef }));
  });
  return resultRef;
}

function requireResult(resultRef: { current: CreatorResult | null }): CreatorResult {
  const result = resultRef.current;
  if (result === null) {
    throw new Error('useNewSessionCreator did not run');
  }
  return result;
}

// Counts the frames the hook schedules and fires them synchronously. The
// creator must not defer any navigation work to a frame boundary — a stack
// mutation dispatched one frame after the push crashed Fabric on Android. The
// stub is hoisted so it is not an inline callback argument
// (prefer-await-to-callbacks); the parameter is named `frame` because the
// promise plugin treats a `callback`-named parameter as a promise callback.
const scheduledFrames = { count: 0 };
const requestAnimationFrameStub = (frame: () => void): number => {
  scheduledFrames.count += 1;
  frame();
  return 0;
};

// Helper to produce a controllable promise without uninitialized variables
// (same shape as src/lib/hooks/use-tracking-permission-prompt.test.ts).
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let storedResolve: ((value: T) => void) | undefined = undefined;
  const promise = new Promise<T>(resolve => {
    storedResolve = resolve;
  });
  return {
    promise,
    resolve: (value: T) => {
      storedResolve?.(value);
    },
  };
}

async function flushMicrotasks(): Promise<void> {
  await act(async () => {
    await new Promise(resolve => {
      setTimeout(resolve, 0);
    });
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  prepareSessionMutate.mockResolvedValue({ kiloSessionId: 'sess-1' });
  invalidateAgentSessionQueries.mockResolvedValue(undefined);
  hapticsMock.calls = 0;
  hapticsMock.rejectWith = undefined;
  attachmentsWire = null;
  scheduledFrames.count = 0;
  outboxMock.getStoredOperationKey.mockReturnValue(null);
  outboxMock.writeSafeRetry.mockResolvedValue(undefined);
  outboxMock.remove.mockResolvedValue(undefined);
  outboxMock.whenLoaded.mockResolvedValue(true);
  vi.stubGlobal('requestAnimationFrame', requestAnimationFrameStub);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// P1-A-08b: `useNewSessionCreator` must attach one stable `operationKey` per
// submit intent to `prepareSession`, keep it across retryable failures
// (incl. `creation_in_progress`), and rotate it on success or a typed
// non-retryable rejection. Run through a fake React dispatcher so the hook's
// own refs/callbacks are exercised without mounting React Native.

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
};

function runCreator(args: {
  mode?: string;
  model?: string;
  variant?: string;
  organizationId?: string;
  selectedRepo?: string;
  autoCommit?: boolean;
  profileId?: string | null;
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
      // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- attachment fake shape; only `attachments` and `uploadPending` are read by the create path
      attachments: {
        attachments: [],
        uploadPending: async () => ({
          ok: true as const,
          wire: attachmentsWire,
          submission: undefined,
        }),
      } as never,
      mode: (args.mode ?? 'code') as never,
      model: args.model ?? 'model-1',
      organizationId: args.organizationId,
      selectedRepo: args.selectedRepo ?? 'owner/repo',
      // eslint-disable-next-line no-empty-function -- no-op state setter
      setIsCreating: () => {},
      variant: args.variant ?? 'v1',
      autoCommit: args.autoCommit ?? false,
      profileId: args.profileId,
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
    invalidateAgentSessionQueries.mockReset();
    invalidateAgentSessionQueries.mockResolvedValue(undefined);
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

  // The transport-failure and transient-5xx branches of the retryability
  // predicate are covered in mobile-session-manager.test.ts; the hook only
  // needs one retryable and one terminal case.
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
    routerReplace.mockImplementationOnce(() => {
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

  it('navigates once and defers no stack mutation to a later frame', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    // The old form pushed the session route and then dispatched a stack RESET
    // one frame later to drop `agent-chat/new`. That second commit landed while
    // the native push transition was still running and crashed Fabric on
    // Android (Sentry KILO-APP-25). `replace` reaches the same stack in one
    // commit, so nothing may be scheduled on a frame boundary.
    expect(routerReplace).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith(
      expect.stringContaining(`agent-chat/${sessionResult().kiloSessionId}`)
    );
    expect(scheduledFrames.count).toBe(0);
  });
});

describe('useNewSessionCreator mode passthrough', () => {
  it('passes a custom mode slug through unchanged to prepareSession', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    const creator = runCreator({ mode: 'reviewer' });

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      mode: 'reviewer',
    });
  });
});

describe('useNewSessionCreator onCreated', () => {
  it('fires onCreated once on success, before navigating', async () => {
    const onCreated = vi.fn(() => undefined);
    const resultRef = mountCreator(createInput({ organizationId: 'org-1', onCreated }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    promptRef.current = 'Hello agent';

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(prepareSessionMutate).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith(expect.stringContaining('agent-chat/sess-1'));
    expect(captureEventMock).toHaveBeenCalledWith('session_created', expect.anything());
    expect(invalidateAgentSessionQueries).toHaveBeenCalledTimes(1);
    expect(toastError).not.toHaveBeenCalled();
  });

  it('contains a throwing onCreated callback and still navigates', async () => {
    const onCreated = vi.fn(() => {
      throw new Error('host callback failed');
    });
    const resultRef = mountCreator(createInput({ organizationId: 'org-1', onCreated }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    promptRef.current = 'Hello agent';

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(onCreated).toHaveBeenCalledTimes(1);
    expect(routerReplace).toHaveBeenCalledWith(expect.stringContaining('agent-chat/sess-1'));
    expect(toastError).not.toHaveBeenCalled();
  });

  it('never fires onCreated when prepareSession rejects, and preserves the draft', async () => {
    prepareSessionMutate.mockRejectedValueOnce(new Error('boom'));
    const onCreated = vi.fn(() => undefined);
    const resultRef = mountCreator(createInput({ organizationId: 'org-1', onCreated }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    promptRef.current = 'Hello agent';

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(onCreated).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('boom');
  });

  it('does not prepare (and never fires onCreated) when the draft is empty', async () => {
    const onCreated = vi.fn(() => undefined);
    const resultRef = mountCreator(createInput({ organizationId: 'org-1', onCreated }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    promptRef.current = '   ';

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(prepareSessionMutate).not.toHaveBeenCalled();
    expect(onCreated).not.toHaveBeenCalled();
    expect(routerReplace).not.toHaveBeenCalled();
  });
});

describe('useNewSessionCreator profileId', () => {
  it('passes profileId into prepareSession when an effective id exists', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    const creator = runCreator({ profileId: 'profile-1' });

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({ profileId: 'profile-1' });
  });

  it('omits profileId from prepareSession when no effective id exists', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(prepareSessionMutate.mock.calls[0]?.[0]).not.toHaveProperty('profileId');
  });
});

describe('useNewSessionCreator autoCommit', () => {
  it('sends autoCommit false (Leave changes) by default', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({ autoCommit: false });
  });

  it('sends autoCommit true when Commit and push is chosen', async () => {
    prepareSessionMutate.mockResolvedValue(sessionResult());
    const creator = runCreator({ autoCommit: true });

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({ autoCommit: true });
  });
});

describe('useNewSessionCreator mutation outbox (P1-E-40c)', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    prepareSessionMutate.mockResolvedValue(sessionResult());
    outboxMock.getStoredOperationKey.mockReturnValue(null);
    outboxMock.writeSafeRetry.mockReset();
    outboxMock.writeSafeRetry.mockResolvedValue(undefined);
    outboxMock.remove.mockReset();
    outboxMock.remove.mockResolvedValue(undefined);
  });

  it('writes a safe-retry row before mutate and removes it on success', async () => {
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

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
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

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
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(order).toEqual(['whenLoaded', 'getStoredOperationKey']);
    expect(prepareSessionMutate.mock.calls[0]?.[0]).toMatchObject({
      operationKey: 'stored-op-key',
    });
  });

  it('refuses to create when the outbox read failed (no duplicate key)', async () => {
    outboxMock.whenLoaded.mockResolvedValueOnce(false);
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(prepareSessionMutate).not.toHaveBeenCalled();
    expect(outboxMock.writeSafeRetry).not.toHaveBeenCalled();
    expect(toastError).toHaveBeenCalledWith('Could not read pending sessions. Try again.');
  });

  it('keeps the row on a retryable failure so a relaunch reuses the key', async () => {
    prepareSessionMutate.mockRejectedValueOnce(creationInProgressError());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(outboxMock.remove).not.toHaveBeenCalled();
  });

  it('removes the row on a terminal failure', async () => {
    prepareSessionMutate.mockRejectedValueOnce(badRequestError());
    const creator = runCreator({});

    creator.promptRef.current = 'hello';
    await creator.createSessionFromDraft();

    expect(outboxMock.remove).toHaveBeenCalledTimes(1);
  });
});

describe('restored new-session submit', () => {
  it('sends the restored prompt without editing once the route seeds the prompt ref', async () => {
    const resultRef = mountCreator(createInput({ organizationId: 'org-1' }));
    const { createSessionFromDraft, promptRef } = requireResult(resultRef);
    // Mirrors the route's draft-settle seeding: the restored text feeds the
    // creator's promptRef and enables submit.
    promptRef.current = 'Restored draft prompt';

    await act(async () => {
      await createSessionFromDraft();
    });

    expect(prepareSessionMutate).toHaveBeenCalledWith(
      expect.objectContaining({ prompt: 'Restored draft prompt' })
    );
    expect(routerReplace).toHaveBeenCalledWith(expect.stringContaining('agent-chat/sess-1'));
  });
});

type DraftLoadState = { settled: boolean; value: string | null };

function FencedDraftHarness({
  userId,
  isIdentityLoading,
  entityKey,
  onRender,
}: {
  userId: string | undefined;
  isIdentityLoading: boolean;
  entityKey: string;
  onRender: (state: DraftLoadState) => void;
}) {
  const state = useFencedDraftLoad({ userId, isIdentityLoading, entityKey });
  onRender(state);
  return null;
}

// The fence must hold for both generation sources: switching accounts and
// switching the entity key (session). Only the changing field differs, so one
// table drives the identical three steps.
const FENCE_CASES = [
  {
    name: 'an account switch',
    first: { userId: 'u1', entityKey: 'agent-composer:new' },
    second: { userId: 'u2', entityKey: 'agent-composer:new' },
    staleText: 'old account draft',
    freshText: 'new account draft',
  },
  {
    name: 'the entity key changes',
    first: { userId: 'u1', entityKey: 'agent-composer:sess-1' },
    second: { userId: 'u1', entityKey: 'agent-composer:sess-2' },
    staleText: 'old session draft',
    freshText: 'new session draft',
  },
] as const;

describe('useFencedDraftLoad generation fencing', () => {
  it.each(FENCE_CASES)(
    'never publishes an old load after $name',
    async ({ first, second, staleText, freshText }) => {
      const firstLoad = deferred<string | null>();
      const secondLoad = deferred<string | null>();
      vi.mocked(loadDraft)
        .mockImplementationOnce(async () => firstLoad.promise)
        .mockImplementationOnce(async () => secondLoad.promise);

      const renders: DraftLoadState[] = [];
      let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
      act(() => {
        renderer = TestRenderer.create(
          React.createElement(FencedDraftHarness, {
            ...first,
            isIdentityLoading: false,
            onRender: state => {
              renders.push(state);
            },
          })
        );
      });

      // The generation changes while the first load is still in flight.
      act(() => {
        renderer?.update(
          React.createElement(FencedDraftHarness, {
            ...second,
            isIdentityLoading: false,
            onRender: state => {
              renders.push(state);
            },
          })
        );
      });

      // The superseded load resolves late: it must not publish into the
      // newest generation's screen.
      await act(async () => {
        firstLoad.resolve(staleText);
      });
      await flushMicrotasks();
      expect(renders.at(-1)).toEqual({ settled: false, value: null });

      // The current generation's load resolves: it publishes.
      await act(async () => {
        secondLoad.resolve(freshText);
      });
      await flushMicrotasks();
      expect(renders.at(-1)).toEqual({ settled: true, value: freshText });
      expect(vi.mocked(loadDraft)).toHaveBeenCalledWith(
        second.userId,
        second.entityKey,
        expect.anything()
      );
    }
  );

  it('never publishes a load that resolves after unmount', async () => {
    const gate = deferred<string | null>();
    vi.mocked(loadDraft).mockImplementationOnce(async () => gate.promise);

    const renders: DraftLoadState[] = [];
    let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
    act(() => {
      renderer = TestRenderer.create(
        React.createElement(FencedDraftHarness, {
          userId: 'u1',
          isIdentityLoading: false,
          entityKey: 'agent-composer:sess-1',
          onRender: state => {
            renders.push(state);
          },
        })
      );
    });
    act(() => {
      renderer?.unmount();
    });

    await act(async () => {
      gate.resolve('late draft');
    });
    await flushMicrotasks();
    expect(renders.at(-1)).toEqual({ settled: false, value: null });
  });
});

type RemoteSpawnDraftCleanupResult = ReturnType<typeof useRemoteSpawnDraftCleanup>;

function RemoteSpawnDraftCleanupHarness({
  userId,
  resultRef,
}: {
  userId: string | undefined;
  resultRef: { current: RemoteSpawnDraftCleanupResult | null };
}) {
  const result = useRemoteSpawnDraftCleanup({ userId });
  resultRef.current = result;
  return null;
}

function mountRemoteSpawnDraftCleanup(userId: string | undefined): {
  renderer: TestRenderer.ReactTestRenderer | undefined;
  resultRef: { current: RemoteSpawnDraftCleanupResult | null };
} {
  const resultRef: { current: RemoteSpawnDraftCleanupResult | null } = { current: null };
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  act(() => {
    renderer = TestRenderer.create(
      React.createElement(RemoteSpawnDraftCleanupHarness, { userId, resultRef })
    );
  });
  return { renderer, resultRef };
}

describe('useRemoteSpawnDraftCleanup remote-spawn clear', () => {
  beforeEach(() => {
    vi.mocked(clearDraft).mockClear();
    vi.mocked(flushDraft).mockClear();
  });

  it('clears agent-composer:new when the screen unmounts after an admitted remote spawn', async () => {
    const { renderer, resultRef } = mountRemoteSpawnDraftCleanup('u1');
    // The route arms the marker only once the dispatch admits the spawn
    // (voice settlement + admission passed); an admitted attempt means the
    // spawn was committed to.
    act(() => {
      resultRef.current?.markRemoteSpawnAttempted();
    });
    // A failed spawn keeps the screen mounted (toast, stay): while mounted,
    // the draft must be preserved for the retry.
    expect(vi.mocked(clearDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(flushDraft)).not.toHaveBeenCalled();

    // A successful spawn replaces the screen: the unmount clears the consumed
    // draft so the submitted prompt cannot reappear on the next visit.
    act(() => {
      renderer?.unmount();
    });
    expect(vi.mocked(clearDraft)).toHaveBeenCalledWith('u1', 'agent-composer:new');
    expect(vi.mocked(flushDraft)).not.toHaveBeenCalledWith('u1', 'agent-composer:new');
  });

  it('flushes (never clears) the draft when the screen unmounts after a blocked admission or cancelled voice submit — the marker was never armed', async () => {
    const { renderer } = mountRemoteSpawnDraftCleanup('u1');
    // No `markRemoteSpawnAttempted` call: the tap stopped before any spawn
    // attempt (denied admission, voice settle aborted, or a plain back
    // leave), so the unmount must preserve the typed prompt.
    act(() => {
      renderer?.unmount();
    });
    expect(vi.mocked(flushDraft)).toHaveBeenCalledWith('u1', 'agent-composer:new');
    expect(vi.mocked(clearDraft)).not.toHaveBeenCalled();
  });

  it('never clears or flushes when the userId is unknown', async () => {
    const { renderer, resultRef } = mountRemoteSpawnDraftCleanup(undefined);
    act(() => {
      resultRef.current?.markRemoteSpawnAttempted();
    });
    act(() => {
      renderer?.unmount();
    });
    expect(vi.mocked(clearDraft)).not.toHaveBeenCalled();
    expect(vi.mocked(flushDraft)).not.toHaveBeenCalled();
  });
});
