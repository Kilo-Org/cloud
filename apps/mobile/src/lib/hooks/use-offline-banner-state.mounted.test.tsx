/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/components/agents/fixed-part-row.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useOfflineBannerState } from '@/lib/hooks/use-offline-banner-state';
import { OFFLINE_BANNER_SHOW_DELAY_MS } from '@/lib/offline-banner-state';

type ConnectivityState = { isConnected: boolean | null; isInternetReachable: boolean | null };

const netinfo = vi.hoisted(() => {
  const listeners = new Set<(state: ConnectivityState) => void>();
  return {
    listeners,
    addEventListener: (listener: (state: ConnectivityState) => void): (() => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (state: ConnectivityState): void => {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

vi.mock('@react-native-community/netinfo', () => ({
  addEventListener: netinfo.addEventListener,
}));

function Probe() {
  const isOffline = useOfflineBannerState();
  return createElement('ProbeText', null, String(isOffline));
}

function textChildren(renderer: TestRenderer.ReactTestRenderer): string[] | null {
  const json = renderer.toJSON();
  if (!json) {
    return null;
  }
  if (Array.isArray(json)) {
    return null;
  }
  return json.children?.filter((child): child is string => typeof child === 'string') ?? null;
}

async function renderProbe(): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(Probe));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  return renderer;
}

describe('useOfflineBannerState mounted', () => {
  beforeEach(() => {
    // React 19 requires the act environment flag before `act` supports
    // updates scheduled from effects and external stores.
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  });
  afterEach(() => {
    netinfo.listeners.clear();
    vi.useRealTimers();
  });

  it('subscribes once, shows after the delay, hides at once, and cleans up on unmount', async () => {
    vi.useFakeTimers();

    const renderer = await renderProbe();

    expect(netinfo.listeners.size).toBe(1);
    expect(textChildren(renderer)).toEqual(['false']);

    act(() => {
      netinfo.emit({ isConnected: false, isInternetReachable: false });
    });
    expect(textChildren(renderer)).toEqual(['false']);

    act(() => {
      vi.advanceTimersByTime(OFFLINE_BANNER_SHOW_DELAY_MS);
    });
    expect(textChildren(renderer)).toEqual(['true']);

    act(() => {
      netinfo.emit({ isConnected: true, isInternetReachable: true });
    });
    expect(textChildren(renderer)).toEqual(['false']);

    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      act(() => {
        renderer.unmount();
      });

      expect(netinfo.listeners.size).toBe(0);

      act(() => {
        netinfo.emit({ isConnected: false, isInternetReachable: false });
        vi.advanceTimersByTime(OFFLINE_BANNER_SHOW_DELAY_MS);
      });

      expect(renderer.toJSON()).toBeNull();
      expect(consoleErrorSpy).not.toHaveBeenCalled();
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });
});
