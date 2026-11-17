/* eslint-disable require-await, @typescript-eslint/require-await -- the SecureStore mock settles without await because it resolves immediately */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The recovery half of the system-search routing: a picked result the phone's
// index could not resolve yet. Its own suite, because these cases need the
// toast adapter mocked on top of the slot and deep-link mocks the routing
// suite already carries.
const store = new Map<string, string>();

const secureStoreMock = {
  setItemAsync: vi.fn(async (key: string, value: string) => {
    store.set(key, value);
    await Promise.resolve();
  }),
  deleteItemAsync: vi.fn(async (key: string) => {
    store.delete(key);
    await Promise.resolve();
  }),
  getItemAsync: vi.fn(async (key: string) => {
    await Promise.resolve();
    return store.get(key) ?? null;
  }),
};

const mocks = vi.hoisted(() => {
  const consumePendingRoute = vi.fn<() => Promise<string | null>>();
  consumePendingRoute.mockResolvedValue(null);
  return {
    consumePendingRoute,
    addListener: vi.fn<(listener: () => void) => { remove: () => void } | null>(() => ({
      remove: vi.fn<() => void>(),
    })),
    toastError: vi.fn<(title: string, options?: unknown) => string | number>(),
  };
});

vi.mock('@sentry/react-native', () => ({ captureException: vi.fn() }));

vi.mock('expo-secure-store', () => ({
  getItemAsync: vi.fn(async () => null),
  setItemAsync: vi.fn(async () => undefined),
  deleteItemAsync: vi.fn(async () => undefined),
}));

vi.mock('@/lib/native-system-search', () => ({
  consumePendingSystemSearchRoute: mocks.consumePendingRoute,
  addSystemSearchOpenListener: mocks.addListener,
}));

// The adapter renders `sonner-native` (and reanimated with it); this suite
// asserts the call the routing makes, and a device proof covers the rendering.
vi.mock('@/lib/a11y/announcing-toast', () => ({
  announcingToast: { error: mocks.toastError, success: vi.fn(), warning: vi.fn() },
}));

/* eslint-disable import/first */
import {
  _resetDeepLinkLaunchForTests,
  _setSecureStoreForTests,
  getPendingDeepLinkSnapshot,
  setCurrentDeepLinkUserId,
} from './deep-link-launch';
import { captureSystemSearchLaunch } from './system-search-route';
/* eslint-enable import/first */

const PR_ID = '/(app)/pr-review/owner/repo/42';

/** The coded rejection the module answers when its index read failed. */
const unresolved = Object.assign(
  new Error('The system search index could not resolve this result.'),
  { code: 'ERR_SYSTEM_SEARCH_UNRESOLVED' }
);

/** What the routing handed the toast: its id and the retry it offers. */
function toastOptions(call: number): { id?: string; action?: { onClick?: () => void } } {
  return mocks.toastError.mock.calls[call]?.[1] as {
    id?: string;
    action?: { onClick?: () => void };
  };
}

describe('system-search-route, a tap the index could not resolve', () => {
  beforeEach(() => {
    _resetDeepLinkLaunchForTests();
    _setSecureStoreForTests(secureStoreMock);
    store.clear();
    vi.clearAllMocks();
    mocks.consumePendingRoute.mockResolvedValue(null);
    setCurrentDeepLinkUserId('user-1');
  });

  afterEach(() => {
    _resetDeepLinkLaunchForTests();
    store.clear();
  });

  it('shows the shipped copy and the retry the reader can act on', async () => {
    mocks.consumePendingRoute.mockRejectedValue(unresolved);

    captureSystemSearchLaunch();

    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledOnce();
    });
    expect(mocks.toastError).toHaveBeenCalledWith('Could not open this search result', {
      id: expect.any(String),
      action: { label: 'Try again', onClick: expect.any(Function) },
    });
    expect(getPendingDeepLinkSnapshot()).toBeNull();
  });

  it('routes the tap when the retry resolves it', async () => {
    mocks.consumePendingRoute.mockRejectedValueOnce(unresolved);
    captureSystemSearchLaunch();
    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledOnce();
    });

    // The module kept the picked identifier, so the retry is the same read.
    mocks.consumePendingRoute.mockResolvedValueOnce(PR_ID);
    toastOptions(0).action?.onClick?.();

    await vi.waitFor(() => {
      expect(getPendingDeepLinkSnapshot()).toBe(PR_ID);
    });
    expect(mocks.consumePendingRoute).toHaveBeenCalledTimes(2);
    expect(mocks.toastError).toHaveBeenCalledOnce();
  });

  it('updates one toast for repeated failures instead of stacking copies', async () => {
    mocks.consumePendingRoute.mockRejectedValue(unresolved);

    captureSystemSearchLaunch();
    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledOnce();
    });
    captureSystemSearchLaunch();
    await vi.waitFor(() => {
      expect(mocks.toastError).toHaveBeenCalledTimes(2);
    });

    expect(toastOptions(0).id).toBeDefined();
    expect(toastOptions(1).id).toBe(toastOptions(0).id);
  });

  it('stays silent when the answer names no screen of this app', async () => {
    // The index answered and refused the identifier: nothing to open, nothing
    // to retry, so the toast stays away and only the code means "not yet".
    mocks.consumePendingRoute.mockResolvedValueOnce('https://example.com/agent-chat/session-1');

    captureSystemSearchLaunch();

    await vi.waitFor(() => {
      expect(mocks.consumePendingRoute).toHaveBeenCalledOnce();
    });
    expect(getPendingDeepLinkSnapshot()).toBeNull();
    expect(mocks.toastError).not.toHaveBeenCalled();
  });
});
