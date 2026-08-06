/* eslint-disable import/first -- mocks must be defined before the module under test is imported */
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
  notificationAsync: vi.fn(),
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
  invalidateAgentSessionQueries: vi.fn(),
}));
// The real classifier lives in mobile-session-manager (covered by its own
// suite); this test only needs the retryable/non-retryable split.
vi.mock('@/components/agents/mobile-session-manager', () => ({
  isCloudPrepareRetryableError: (error: unknown) => {
    const record = error as { data?: { code?: string }; message?: string };
    return record.data?.code === 'CONFLICT' && record.message === 'creation_in_progress';
  },
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

describe('useNewSessionCreator operationKey', () => {
  beforeEach(() => {
    prepareSessionMutate.mockReset();
    routerPush.mockClear();
    navigationDispatch.mockClear();
    toastError.mockClear();
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
});
