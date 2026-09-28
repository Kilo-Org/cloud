import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import {
  AFTER_INTERACTIONS_FALLBACK_MS,
  useAfterInteractions,
} from '@/lib/hooks/use-after-interactions';

// ── Hoisted mocks ──────────────────────────────────────────────────────────

const interactionState = vi.hoisted(() => ({
  callback: undefined as (() => void) | undefined,
  cancel: vi.fn(),
}));

vi.mock('react-native', () => ({
  InteractionManager: {
    // eslint-disable-next-line promise/prefer-await-to-callbacks -- the mock must capture the callback so a test can withhold it
    runAfterInteractions: (callback: () => void) => {
      interactionState.callback = callback;
      return { cancel: interactionState.cancel };
    },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

type HookValue = { current: boolean | null };

function Probe({ holder }: { holder: HookValue }) {
  holder.current = useAfterInteractions();
  return null;
}

async function mountProbe(): Promise<{ holder: HookValue; unmount: () => void }> {
  const holder: HookValue = { current: null };
  const renderer = await act(() => TestRenderer.create(createElement(Probe, { holder })));
  return {
    holder,
    unmount: () => {
      renderer.unmount();
    },
  };
}

/** The never-idle state: the captured callback is never invoked. */
async function runFallback(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AFTER_INTERACTIONS_FALLBACK_MS);
  });
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('useAfterInteractions', () => {
  beforeEach(() => {
    interactionState.callback = undefined;
    interactionState.cancel.mockReset();
  });

  // A failing fake-clock test must not leave the fake clock installed for the
  // rest of the file.
  afterEach(() => {
    vi.useRealTimers();
  });

  it('stays false on mount', async () => {
    const { holder, unmount } = await mountProbe();

    expect(holder.current).toBe(false);

    unmount();
  });

  it('resolves when interactions settle, without waiting for the fallback', async () => {
    vi.useFakeTimers();
    const { holder, unmount } = await mountProbe();

    await act(() => {
      interactionState.callback?.();
    });

    expect(holder.current).toBe(true);

    unmount();
  });

  it('repro: resolves anyway when interactions never report idle', async () => {
    vi.useFakeTimers();
    const { holder, unmount } = await mountProbe();

    expect(holder.current).toBe(false);
    // The callback captured by the mock is deliberately left unflushed: an
    // automated session that holds an interaction open never lets it run, so
    // only the fallback can release the deferred work.
    expect(interactionState.callback).toBeTypeOf('function');

    await runFallback();

    expect(holder.current).toBe(true);

    unmount();
  });

  it('stays resolved when the interaction callback arrives after the fallback', async () => {
    vi.useFakeTimers();
    const { holder, unmount } = await mountProbe();

    await runFallback();
    expect(holder.current).toBe(true);

    await act(() => {
      interactionState.callback?.();
    });
    expect(holder.current).toBe(true);

    unmount();
  });

  it('releases the interaction handle and the fallback timer on unmount', async () => {
    vi.useFakeTimers();
    const { unmount } = await mountProbe();

    expect(vi.getTimerCount()).toBe(1);
    unmount();

    expect(interactionState.cancel).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
});
