// Drives the real `createDispatchSessionLink()` rather than the mocked client:
// the link is the only writer of the dispatch tag, so the epoch it records must
// be the one captured when the operation started, not the one current when the
// refusal settles. A link that read the epoch in its `error` callback would
// still pass the "same session" case and fail the "session changed in flight"
// case, which is the regression this suite guards.

import { beforeEach, describe, expect, it, type Mock, vi } from 'vitest';

import { type MobileRouter } from '@kilocode/trpc/mobile';
import {
  type Operation,
  type OperationResultObservable,
  type OperationResultObserver,
  type TRPCClientRuntime,
  type TRPCLink,
} from '@trpc/client';

import { bumpAuthEpoch } from '@/lib/auth/auth-epoch';
import { isFromCurrentDispatchSession } from '@/lib/auth/dispatch-epoch';
import { createDispatchSessionLink } from '@/lib/trpc';

// The link under test reads `@trpc/client` only for types. The module also
// builds the app's real client at import time, which no Node test can own.
vi.mock('@trpc/client', () => ({
  createTRPCClient: vi.fn(() => ({})),
  httpLink: vi.fn(() => () => ({})),
  httpBatchLink: vi.fn(() => () => ({})),
  splitLink: vi.fn(() => () => ({})),
}));

vi.mock('@trpc/tanstack-react-query', () => ({
  createTRPCContext: vi.fn(() => ({
    TRPCProvider: { $$typeof: Symbol.for('react.provider') },
    useTRPC: vi.fn(),
  })),
}));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(() => Promise.resolve(null)),
  setItemAsync: vi.fn(() => Promise.resolve()),
  deleteItemAsync: vi.fn(() => Promise.resolve()),
  WHEN_UNLOCKED_THIS_DEVICE_ONLY: 'WHEN_UNLOCKED_THIS_DEVICE_ONLY',
}));

vi.mock('expo-application', () => ({
  nativeApplicationVersion: '1.0.4',
}));

vi.mock('react-native', () => ({
  Platform: { OS: 'ios' },
}));

vi.mock('@/lib/storage-keys', () => ({
  ACTIVE_USER_ID_KEY: 'active-user-id',
  AUTH_TOKEN_KEY: 'auth-token',
  ORGANIZATION_STORAGE_KEY: 'organization',
  REFRESH_TOKEN_KEY: 'auth-refresh-token',
  TOKEN_EXPIRES_AT_KEY: 'token-expires-at',
}));

type LinkObserver = OperationResultObserver<MobileRouter, unknown>;
// The link hands its downstream observer every member defined; keeping the type
// partial is what lets a case call one member at a time.
type PartialObserver = Partial<LinkObserver>;
type LinkResult = OperationResultObservable<MobileRouter, unknown>;
type NextLink = (op: Operation) => LinkResult;

const OPERATION: Operation = {
  path: 'user.getMe',
  type: 'query',
  input: null,
  context: {},
  signal: null,
  id: 1,
};

type ChainTail = {
  next: NextLink;
  unsubscribe: Mock;
  /** The observer the link subscribed downstream with, once it subscribed. */
  downstream(): PartialObserver;
};

/**
 * The tail of the chain: it hands out the observer the link subscribes with, so
 * a case settles the operation on demand, and records the unsubscribe the link
 * forwards.
 */
function createTail(): ChainTail {
  const captured: { observer?: PartialObserver } = {};
  const unsubscribe = vi.fn();
  const next: NextLink = () => {
    const result = {
      subscribe(observer: LinkObserver) {
        captured.observer = observer;
        return { unsubscribe };
      },
    };
    // `OperationResultObservable` also declares `pipe`, which only the
    // `observable` helper in `@trpc/server` builds. A link's chain only ever
    // calls `subscribe` on the object the next link returns (`trpc.ts` relies on
    // the same fact), so the tail supplies that one member and bridges the rest
    // with a cast.
    return result as unknown as LinkResult;
  };

  return {
    next,
    unsubscribe,
    downstream() {
      if (!captured.observer) {
        throw new Error('the link has not subscribed downstream yet');
      }
      return captured.observer;
    },
  };
}

/** What a case asserts on: the observer the link was subscribed with. */
type CallerRecorder = { next: Mock; error: Mock; complete: Mock };

function createCaller(): CallerRecorder {
  return {
    next: vi.fn(() => undefined),
    error: vi.fn(() => undefined),
    complete: vi.fn(() => undefined),
  };
}

/** Drives the real link over a stubbed chain tail. */
function subscribeThroughLink(tail: ChainTail) {
  const link: TRPCLink<MobileRouter> = createDispatchSessionLink();
  // `TRPCClientRuntime` declares no members, so the empty object is the value.
  const runtime: TRPCClientRuntime = {};
  const result = link(runtime)({ op: OPERATION, next: tail.next });
  const observer = createCaller();
  const subscription = result.subscribe(observer as LinkObserver);
  return { observer, subscription };
}

describe('createDispatchSessionLink', () => {
  beforeEach(() => {
    // A fresh session per case, so a tag from the case before never decides one.
    bumpAuthEpoch();
  });

  it('tags a refusal with the session the operation started in', () => {
    const tail = createTail();
    const { observer } = subscribeThroughLink(tail);
    const error = new Error('refused');

    tail.downstream().error?.(error as never);

    expect(observer.error).toHaveBeenCalledTimes(1);
    expect(observer.error.mock.calls[0]?.[0]).toBe(error);
    expect(isFromCurrentDispatchSession(error)).toBe(true);
  });

  it('keeps the dispatch session when the session changes before the refusal settles', () => {
    const tail = createTail();
    const { observer } = subscribeThroughLink(tail);
    const error = new Error('refused');

    // The sign-out that ended the dispatching session lands while this call is
    // still in flight.
    bumpAuthEpoch();

    tail.downstream().error?.(error as never);

    expect(observer.error).toHaveBeenCalledTimes(1);
    expect(isFromCurrentDispatchSession(error)).toBe(false);
  });

  it('forwards the operation result and completion unchanged', () => {
    const tail = createTail();
    const { observer } = subscribeThroughLink(tail);
    const envelope = { result: { type: 'data', data: { id: 'user-1' } } };

    tail.downstream().next?.(envelope as never);
    tail.downstream().complete?.();

    expect(observer.next).toHaveBeenCalledTimes(1);
    expect(observer.next.mock.calls[0]?.[0]).toBe(envelope);
    expect(observer.complete).toHaveBeenCalledTimes(1);
  });

  it('unsubscribes the downstream subscription the caller cancels', () => {
    const tail = createTail();
    const { subscription } = subscribeThroughLink(tail);

    subscription.unsubscribe();

    expect(tail.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
