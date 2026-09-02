/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer mounts React/RN trees without a DOM */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type ConnectivityState } from '@/lib/connectivity-online';
import { type BannerState } from '@/lib/offline-banner-state';

const offlineState: ConnectivityState = { isConnected: true, isInternetReachable: false };
const onlineState: ConnectivityState = { isConnected: true, isInternetReachable: true };
const netinfo = vi.hoisted(() => {
  const listeners = new Set<(state: ConnectivityState) => void>();
  let current: ConnectivityState | undefined = undefined;
  return {
    listeners,
    addEventListener: (listener: (state: ConnectivityState) => void): (() => void) => {
      listeners.add(listener);
      if (current) {
        listener(current);
      }
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (state: ConnectivityState): void => {
      current = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
    reset: () => {
      current = undefined;
      listeners.clear();
    },
  };
});

vi.mock('@react-native-community/netinfo', () => ({
  addEventListener: netinfo.addEventListener,
}));
vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://configured-api.example.test' }));

const fetchMock = vi.fn<typeof fetch>();
const renderers: TestRenderer.ReactTestRenderer[] = [];
type Hooks = {
  useOfflineBannerState: () => boolean;
  useCommittedConnectivityStatus: () => BannerState;
};

async function loadHooks(): Promise<Hooks> {
  const hooks = await import('@/lib/hooks/use-offline-banner-state');
  return hooks;
}

function Probe({ hooks }: { hooks: Hooks }) {
  const isOffline = hooks.useOfflineBannerState();
  const status = hooks.useCommittedConnectivityStatus();
  return createElement('ProbeText', null, `${String(isOffline)}:${status}`);
}

function textChildren(renderer: TestRenderer.ReactTestRenderer): string[] | null {
  const json = renderer.toJSON();
  if (!json || Array.isArray(json)) {
    return null;
  }
  return json.children?.filter((child): child is string => typeof child === 'string') ?? null;
}

async function renderProbe(hooks: Hooks): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(Probe, { hooks }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  renderers.push(renderer);
  return renderer;
}

async function advanceBy(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

describe('useOfflineBannerState and useCommittedConnectivityStatus mounted', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    vi.resetModules();
    netinfo.reset();
    vi.useFakeTimers();
    fetchMock.mockReset().mockRejectedValue(new TypeError('Network request failed'));
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    act(() => {
      for (const renderer of renderers.splice(0)) {
        renderer.unmount();
      }
    });
    netinfo.reset();
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('keeps tri-state boot, confirms transport failure after five seconds, and recovers immediately', async () => {
    const renderer = await renderProbe(await loadHooks());
    expect(netinfo.listeners.size).toBe(1);
    expect(textChildren(renderer)).toEqual(['false:unknown']);
    act(() => {
      netinfo.emit(offlineState);
    });
    await advanceBy(4999);
    expect(textChildren(renderer)).toEqual(['false:unknown']);
    expect(fetchMock).not.toHaveBeenCalled();
    await advanceBy(1);
    expect(textChildren(renderer)).toEqual(['true:offline']);
    act(() => {
      netinfo.emit(onlineState);
    });
    expect(textChildren(renderer)).toEqual(['false:online']);
  });

  it.each([200, 401, 405, 503])(
    'treats HTTP %s from configured HEAD as reachable',
    async status => {
      fetchMock.mockResolvedValue(new Response(null, { status }));
      netinfo.emit(offlineState);
      const renderer = await renderProbe(await loadHooks());
      await advanceBy(5000);
      expect(textChildren(renderer)).toEqual(['false:online']);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://configured-api.example.test', {
        method: 'HEAD',
        signal: expect.any(AbortSignal),
      });
      const signal = fetchMock.mock.calls[0]?.[1]?.signal;
      await advanceBy(4000);
      expect(signal?.aborted).toBe(false);
      expect(textChildren(renderer)).toEqual(['false:online']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it.each(['cold open', 'resume'])(
    'keeps false NetInfo hidden for nine seconds on %s',
    async sequence => {
      fetchMock.mockResolvedValue(new Response(null, { status: 204 }));
      netinfo.emit(sequence === 'cold open' ? offlineState : onlineState);
      const renderer = await renderProbe(await loadHooks());
      if (sequence === 'resume') {
        expect(textChildren(renderer)).toEqual(['false:online']);
        act(() => {
          netinfo.emit(offlineState);
        });
      }
      await advanceBy(4999);
      expect(textChildren(renderer)?.[0]).toMatch(/^false:/);
      expect(fetchMock).not.toHaveBeenCalled();
      await advanceBy(4001);
      expect(textChildren(renderer)).toEqual(['false:online']);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    }
  );

  it('aborts exactly three seconds after probe start and ignores a late HTTP response', async () => {
    const response = Promise.withResolvers<Response>();
    fetchMock.mockReturnValue(response.promise);
    netinfo.emit(offlineState);
    const renderer = await renderProbe(await loadHooks());
    await advanceBy(5000);
    const signal = fetchMock.mock.calls[0]?.[1]?.signal;
    expect(signal).toBeInstanceOf(AbortSignal);
    await advanceBy(2999);
    expect(signal?.aborted).toBe(false);
    expect(textChildren(renderer)).toEqual(['false:unknown']);
    await advanceBy(1);
    expect(signal?.aborted).toBe(true);
    expect(textChildren(renderer)).toEqual(['true:offline']);
    await act(async () => {
      response.resolve(new Response(null, { status: 200 }));
      await Promise.resolve();
    });
    expect(textChildren(renderer)).toEqual(['true:offline']);
    act(() => {
      netinfo.emit(onlineState);
    });
    expect(textChildren(renderer)).toEqual(['false:online']);
  });

  it('ignores a deadline after NetInfo recovers during confirmation', async () => {
    fetchMock.mockReturnValue(new Promise<Response>(() => undefined));
    netinfo.emit(offlineState);
    const renderer = await renderProbe(await loadHooks());
    await advanceBy(5000);
    expect(textChildren(renderer)).toEqual(['false:unknown']);
    act(() => {
      netinfo.emit(onlineState);
    });
    expect(textChildren(renderer)).toEqual(['false:online']);
    await advanceBy(3000);
    expect(textChildren(renderer)).toEqual(['false:online']);
  });

  it('reports unknown to online even though the banner stays hidden', async () => {
    const renderer = await renderProbe(await loadHooks());
    expect(textChildren(renderer)).toEqual(['false:unknown']);
    act(() => {
      netinfo.emit(onlineState);
    });
    expect(textChildren(renderer)).toEqual(['false:online']);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shares one confirmation and one NetInfo subscription across callers', async () => {
    const hooks = await loadHooks();
    const first = await renderProbe(hooks);
    const second = await renderProbe(hooks);
    expect(netinfo.listeners.size).toBe(1);
    act(() => {
      netinfo.emit(offlineState);
    });
    await advanceBy(5000);
    expect(textChildren(first)).toEqual(['true:offline']);
    expect(textChildren(second)).toEqual(['true:offline']);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('keeps the singleton processing connectivity after its consumers unmount', async () => {
    const hooks = await loadHooks();
    const renderer = await renderProbe(hooks);
    act(() => {
      renderer.unmount();
    });
    act(() => {
      netinfo.emit(offlineState);
    });
    await advanceBy(5000);
    const remounted = await renderProbe(hooks);
    expect(textChildren(remounted)).toEqual(['true:offline']);
    expect(netinfo.listeners.size).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
