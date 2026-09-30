import { createElement } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetNowTickersForTests } from '@/lib/hooks/now-ticker-store';
import { act } from '@/test/renderer';
import { renderWithProviders } from '@/test/render-with-providers';

import { useNowTicker } from './use-now-ticker';

const BASE_TIME = new Date('2026-01-01T00:00:00.000Z').getTime();

type RenderLog = { renders: number; now: number | null };

function Probe({ log }: { log: RenderLog }) {
  const now = useNowTicker(1000);
  log.renders += 1;
  log.now = now;
  return createElement('ProbeText', null, String(now));
}

describe('useNowTicker mounted', () => {
  const cleanups: (() => void)[] = [];

  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.useFakeTimers();
    vi.setSystemTime(BASE_TIME);
  });

  afterEach(() => {
    act(() => {
      for (const cleanup of cleanups.splice(0)) {
        cleanup();
      }
    });
    resetNowTickersForTests();
    vi.clearAllTimers();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('shares one timer and one snapshot across consumers and clears it on unmount', async () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval');
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval');
    const firstLog: RenderLog = { renders: 0, now: null };
    const secondLog: RenderLog = { renders: 0, now: null };

    const first = await renderWithProviders(createElement(Probe, { log: firstLog }));
    const second = await renderWithProviders(createElement(Probe, { log: secondLog }));
    cleanups.push(first.unmount, second.unmount);

    expect(setIntervalSpy).toHaveBeenCalledTimes(1);
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    expect(firstLog.now).toBe(BASE_TIME);
    expect(secondLog.now).toBe(BASE_TIME);

    const firstRenders = firstLog.renders;
    const secondRenders = secondLog.renders;

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });

    expect(firstLog.renders).toBeGreaterThan(firstRenders);
    expect(secondLog.renders).toBeGreaterThan(secondRenders);
    expect(firstLog.now).toBe(BASE_TIME + 1000);
    expect(secondLog.now).toBe(BASE_TIME + 1000);

    act(() => {
      first.unmount();
      second.unmount();
    });
    cleanups.splice(0);
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1);
  });
});
