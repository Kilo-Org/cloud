import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';

import { useRestoredAccountId } from './use-restored-account-id';

const getMe = vi.hoisted(() => ({ data: undefined as { id?: string } | undefined }));
const getItemAsync = vi.hoisted(() => vi.fn<(key: string) => Promise<string | null>>());

vi.mock('@tanstack/react-query', () => ({ useQuery: () => getMe }));
vi.mock('@/lib/trpc', () => ({
  useTRPC: () => ({ user: { getMe: { queryOptions: () => ({}) } } }),
}));
// The secure-store helper reads one bundle-time fault constant from config;
// the module is mocked empty so the suite never loads the real env.
vi.mock('@/lib/config', () => ({}));
vi.mock('expo-secure-store', () => ({ getItemAsync }));

function Probe({
  fence,
  restoredFromStorage,
  onValue,
}: {
  fence: number;
  restoredFromStorage: boolean;
  onValue: (value: string | null) => void;
}): null {
  onValue(useRestoredAccountId(fence, restoredFromStorage));
  return null;
}

function mount(
  fence = 7,
  restoredFromStorage = true
): {
  latest: () => string | null;
  update: (nextFence: number, nextRestored?: boolean) => Promise<void>;
  unmount: () => void;
} {
  const current: { value: string | null } = { value: null };
  const ref: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
  act(() => {
    ref.renderer = TestRenderer.create(
      createElement(Probe, {
        fence,
        restoredFromStorage,
        onValue: value => {
          current.value = value;
        },
      })
    );
  });
  const renderer = ref.renderer;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  onTestFinished(() => {
    act(() => {
      renderer.unmount();
    });
  });
  return {
    latest: () => current.value,
    update: async (nextFence, nextRestored = restoredFromStorage) => {
      await act(async () => {
        renderer.update(
          createElement(Probe, {
            fence: nextFence,
            restoredFromStorage: nextRestored,
            onValue: value => {
              current.value = value;
            },
          })
        );
        await Promise.resolve();
      });
    },
    unmount: () => {
      act(() => {
        renderer.unmount();
      });
    },
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    for (let round = 0; round < 3; round += 1) {
      // eslint-disable-next-line no-await-in-loop -- one macrotask per round lets the keystore read and its state update settle
      await new Promise<void>(resolve => {
        setTimeout(resolve, 0);
      });
    }
  });
}

/** A promise the test settles by hand: holds one keystore read in flight. */
function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  // The Promise executor supplies the resolver synchronously; the placeholder
  // is replaced before any caller can invoke it.
  const callbacks: { resolve: (value: T) => void } = { resolve: () => undefined };
  const promise = new Promise<T>(resolve => {
    callbacks.resolve = resolve;
  });
  return {
    promise,
    resolve: value => {
      callbacks.resolve(value);
    },
  };
}

beforeEach(() => {
  getMe.data = undefined;
  getItemAsync.mockReset();
  getItemAsync.mockResolvedValue(null);
});

describe('useRestoredAccountId', () => {
  it('answers with the confirmed account without reading the persisted hint', async () => {
    getMe.data = { id: 'user-live' };
    getItemAsync.mockResolvedValue('user-hint');
    const probe = mount();

    await settle();

    expect(probe.latest()).toBe('user-live');
    expect(getItemAsync).not.toHaveBeenCalled();
  });

  it('falls back to the persisted account hint when the query has no id', async () => {
    getItemAsync.mockResolvedValue('user-hint');
    const probe = mount();

    await settle();

    expect(probe.latest()).toBe('user-hint');
  });

  it('ignores the persisted hint for fresh credentials that are not a restore', async () => {
    // A direct credential switch: the new session's credentials are committed
    // but unconfirmed, while the hint still names the previous account. The
    // hint must not scope local data until the new account is confirmed.
    getItemAsync.mockResolvedValue('user-previous');
    const probe = mount(7, false);

    await settle();

    expect(probe.latest()).toBeNull();
    expect(getItemAsync).not.toHaveBeenCalled();
  });

  it('drops a restored hint when the session stops being a restore', async () => {
    getItemAsync.mockResolvedValue('user-previous');
    const probe = mount(1, true);
    await settle();
    expect(probe.latest()).toBe('user-previous');

    // A sign-in over the restored session revokes ownership and clears the
    // restored flag; the previous account's hint must not scope the new one.
    await probe.update(2, false);
    await settle();

    expect(probe.latest()).toBeNull();
  });

  it('answers null when neither the query nor the hint names an account', async () => {
    const probe = mount();

    await settle();

    expect(probe.latest()).toBeNull();
  });

  it('answers null when the keystore read rejects', async () => {
    getItemAsync.mockRejectedValue(new Error('keystore unavailable'));
    const probe = mount();

    await settle();

    expect(probe.latest()).toBeNull();
  });

  it('re-reads the hint when the auth epoch moves', async () => {
    getItemAsync.mockResolvedValueOnce('user-a').mockResolvedValueOnce('user-b');
    const probe = mount(1);
    await settle();
    expect(probe.latest()).toBe('user-a');

    await probe.update(2);
    await settle();

    expect(probe.latest()).toBe('user-b');
  });

  it('ignores a hint read that settles after the auth epoch moves', async () => {
    const first = deferred<string | null>();
    const second = deferred<string | null>();
    getItemAsync.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const probe = mount(1);

    // The epoch moves while the first read is still in flight, so whatever it
    // returns belongs to the account the new epoch replaced.
    await probe.update(2);
    second.resolve('user-b');
    await settle();
    expect(probe.latest()).toBe('user-b');

    // The replaced read settles last: the hint it holds must not scope the next
    // account's local data.
    first.resolve('user-a');
    await settle();

    expect(probe.latest()).toBe('user-b');
  });
});
