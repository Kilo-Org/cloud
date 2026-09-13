/* oxlint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer for RN hooks under vitest (node env, no jsdom) */
/* oxlint-disable @typescript-eslint/no-unsafe-call @typescript-eslint/no-unsafe-member-access */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TOUR_COMPLETED_KEY_PREFIX } from '@/lib/storage-keys';
import {
  readTourCompleted,
  recordTourCompleted,
  tourCompletedKey,
  useTourCompletion,
} from './tour-completion';

const store = vi.hoisted(() => new Map<string, string>());

const { getItemAsync, setItemAsync } = vi.hoisted(() => ({
  getItemAsync: vi.fn(),
  setItemAsync: vi.fn(),
}));

vi.mock('expo-secure-store', () => ({ getItemAsync, setItemAsync }));

type TourCompletion = ReturnType<typeof useTourCompletion>;

async function flushMicrotasks(): Promise<void> {
  await new Promise<void>(resolve => {
    setImmediate(resolve);
  });
}

async function mountHarness(userId: string): Promise<{
  ref: { current: TourCompletion | null };
  unmount: () => void;
}> {
  const ref: { current: TourCompletion | null } = { current: null };
  function Harness(): null {
    ref.current = useTourCompletion(userId);
    return null;
  }
  let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;
  await act(async () => {
    renderer = TestRenderer.create(createElement(Harness));
    await flushMicrotasks();
  });
  return {
    ref,
    unmount: () => {
      renderer?.unmount();
    },
  };
}

describe('tour completion', () => {
  beforeEach(() => {
    store.clear();
    getItemAsync.mockReset();
    setItemAsync.mockReset();
    getItemAsync.mockImplementation((key: string) => store.get(key) ?? null);
    setItemAsync.mockImplementation((key: string, value: string) => {
      store.set(key, value);
    });
  });

  it('builds a distinct storage key per user', () => {
    expect(tourCompletedKey('user-1')).toBe(tourCompletedKey('user-1'));
    expect(tourCompletedKey('user-1')).not.toBe(tourCompletedKey('user-2'));
    expect(tourCompletedKey('user-1').startsWith(TOUR_COMPLETED_KEY_PREFIX)).toBe(true);
  });

  it('round-trips a recorded decision per user', async () => {
    await recordTourCompleted('user-1');

    expect(store.get(tourCompletedKey('user-1'))).toBe('1');
    expect(await readTourCompleted('user-1')).toBe(true);
    // A different account has no decision.
    expect(await readTourCompleted('user-2')).toBe(false);
  });

  it('treats an absent record as not completed', async () => {
    expect(await readTourCompleted('user-fresh')).toBe(false);
  });

  it('treats a read failure as not completed and does not throw', async () => {
    getItemAsync.mockRejectedValueOnce(new Error('keystore unavailable'));

    await expect(readTourCompleted('user-1')).resolves.toBe(false);
  });

  it('recordCompleted sets the in-memory value synchronously and persists in the background', async () => {
    const { ref, unmount } = await mountHarness('user-hook');

    expect(ref.current?.isLoaded).toBe(true);
    expect(ref.current?.isCompleted).toBe(false);

    // A synchronous act() flushes only synchronous updates: if the in-memory
    // value were deferred behind a promise, isCompleted would still be false.
    act(() => {
      ref.current?.recordCompleted();
    });
    expect(ref.current?.isCompleted).toBe(true);
    expect(ref.current?.isLoaded).toBe(true);

    await flushMicrotasks();
    expect(setItemAsync).toHaveBeenCalledWith(tourCompletedKey('user-hook'), '1');

    unmount();
  });

  it('lets a synchronous record win over an in-flight disk read', async () => {
    let resolveRead: ((raw: string | null) => void) | undefined = undefined;
    getItemAsync.mockReturnValueOnce(
      new Promise<string | null>(resolve => {
        resolveRead = resolve;
      })
    );

    const { ref, unmount } = await mountHarness('user-race');

    act(() => {
      ref.current?.recordCompleted();
    });
    expect(ref.current?.isCompleted).toBe(true);

    await act(async () => {
      resolveRead?.(null);
      await flushMicrotasks();
    });

    // The stale disk read must not clear the in-memory decision.
    expect(ref.current?.isCompleted).toBe(true);

    unmount();
  });
});
