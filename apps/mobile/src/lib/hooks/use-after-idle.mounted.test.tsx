/* eslint-disable promise/prefer-await-to-callbacks -- exercises the native idle callback and cancellation contract */
import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act, TestRenderer } from '@/test/renderer';
import { AFTER_IDLE_FALLBACK_MS, useAfterIdle } from '@/lib/hooks/use-after-idle';

const idleState = {
  callback: undefined as (() => void) | undefined,
  cancel: vi.fn(),
};

type HookValue = { current: boolean | null };

function Probe({ holder }: { holder: HookValue }) {
  holder.current = useAfterIdle();
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

async function runFallback(): Promise<void> {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(AFTER_IDLE_FALLBACK_MS);
  });
}

describe('useAfterIdle', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    idleState.callback = undefined;
    idleState.cancel.mockReset();
    vi.stubGlobal('requestIdleCallback', (callback: () => void) => {
      idleState.callback = callback;
      return 1;
    });
    vi.stubGlobal('cancelIdleCallback', idleState.cancel);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('stays false on mount', async () => {
    const { holder, unmount } = await mountProbe();

    expect(holder.current).toBe(false);

    unmount();
  });

  it('resolves when JS becomes idle, without waiting for the fallback', async () => {
    const { holder, unmount } = await mountProbe();

    await act(() => {
      idleState.callback?.();
    });

    expect(holder.current).toBe(true);

    unmount();
  });

  it('resolves at the deadline when JS never becomes idle', async () => {
    const { holder, unmount } = await mountProbe();

    expect(holder.current).toBe(false);
    expect(idleState.callback).toBeTypeOf('function');

    await runFallback();

    expect(holder.current).toBe(true);

    unmount();
  });

  it('stays resolved when the idle callback arrives after the fallback', async () => {
    const { holder, unmount } = await mountProbe();

    await runFallback();
    expect(holder.current).toBe(true);

    await act(() => {
      idleState.callback?.();
    });
    expect(holder.current).toBe(true);

    unmount();
  });

  it('cancels the idle callback and releases the fallback timer on unmount', async () => {
    const { unmount } = await mountProbe();

    expect(vi.getTimerCount()).toBe(1);
    unmount();

    expect(idleState.cancel).toHaveBeenCalledExactlyOnceWith(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('ignores an idle callback delivered after unmount', async () => {
    const { holder, unmount } = await mountProbe();
    unmount();
    await act(() => {
      idleState.callback?.();
    });
    expect(holder.current).toBe(false);
  });
});
