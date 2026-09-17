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
  onValue,
}: {
  fence: number;
  onValue: (value: string | null) => void;
}): null {
  onValue(useRestoredAccountId(fence));
  return null;
}

function mount(fence = 7): {
  latest: () => string | null;
  update: (nextFence: number) => Promise<void>;
  unmount: () => void;
} {
  const current: { value: string | null } = { value: null };
  const ref: { renderer: TestRenderer.ReactTestRenderer | undefined } = { renderer: undefined };
  act(() => {
    ref.renderer = TestRenderer.create(
      createElement(Probe, {
        fence,
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
    update: async nextFence => {
      await act(async () => {
        renderer.update(
          createElement(Probe, {
            fence: nextFence,
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
});
