/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/lib/hooks/use-offline-banner-state.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { clearForceUpdateSignal, reportTrpcError } from '@/lib/force-update-signal';
import { useForceUpdate } from '@/lib/hooks/use-force-update';

const fetchMock = vi.hoisted(() => vi.fn());

const application = vi.hoisted(() => ({
  nativeApplicationVersion: '1.0.4' as string | null,
}));

const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (state: string): void => {
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

const online = vi.hoisted(() => {
  const listeners = new Set<(online: boolean) => void>();
  return {
    listeners,
    subscribe: (listener: (online: boolean) => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    emit: (value: boolean): void => {
      for (const listener of listeners) {
        listener(value);
      }
    },
  };
});

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));
vi.mock('expo-application', () => application);
vi.mock('react-native', () => ({
  Platform: { OS: 'android' },
  AppState: { addEventListener: appState.addEventListener },
}));
vi.mock('@tanstack/react-query', () => ({
  onlineManager: { subscribe: online.subscribe },
}));

function okResponse(body: unknown): Response {
  return Response.json(body);
}

function Probe() {
  const { updateRequired, isChecking } = useForceUpdate();
  return createElement('ProbeText', null, `${updateRequired}:${isChecking}`);
}

function textChildren(renderer: TestRenderer.ReactTestRenderer): string[] | null {
  const json = renderer.toJSON();
  if (!json || Array.isArray(json)) {
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

async function flush(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

const BASE_TIME = 100_000;
let currentTime = BASE_TIME;

describe('useForceUpdate mounted', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    currentTime = BASE_TIME;
    vi.spyOn(Date, 'now').mockImplementation(() => currentTime);
    vi.stubGlobal('fetch', fetchMock);
    fetchMock.mockReset();
    application.nativeApplicationVersion = '1.0.4';
    clearForceUpdateSignal();
  });

  afterEach(() => {
    appState.listeners.clear();
    online.listeners.clear();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('rechecks on foreground (AppState → active)', async () => {
    fetchMock.mockResolvedValue(okResponse({ ios: '1.0.0', android: '1.0.0' }));
    const renderer = await renderProbe();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(textChildren(renderer)).toEqual(['false:false']);

    currentTime = BASE_TIME + 30_000;
    act(() => {
      appState.emit('active');
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('rechecks on the offline→online transition', async () => {
    fetchMock.mockResolvedValue(okResponse({ ios: '1.0.0', android: '1.0.0' }));
    await renderProbe();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    currentTime = BASE_TIME + 30_000;
    act(() => {
      online.emit(true);
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is bounded to one check per 30 s', async () => {
    fetchMock.mockResolvedValue(okResponse({ ios: '1.0.0', android: '1.0.0' }));
    await renderProbe();
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    currentTime = BASE_TIME + 10_000;
    act(() => {
      appState.emit('active');
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    currentTime = BASE_TIME + 30_000;
    act(() => {
      appState.emit('active');
    });
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('is single-flight: a newer check aborts the in-flight one', async () => {
    const firstSignal = { signal: undefined as AbortSignal | undefined };
    fetchMock
      .mockImplementationOnce(async (_url: unknown, init?: { signal?: AbortSignal }) => {
        firstSignal.signal = init?.signal;
        // Never resolves, so the first check stays in flight.
        await new Promise<never>(() => undefined);
      })
      .mockResolvedValueOnce(okResponse({ ios: '1.0.0', android: '1.0.0' }));

    await renderProbe();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    currentTime = BASE_TIME + 30_000;
    act(() => {
      appState.emit('active');
    });
    await flush();

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(firstSignal.signal?.aborted).toBe(true);
  });

  it('clears the block when the server lowers the minimum', async () => {
    fetchMock.mockResolvedValue(okResponse({ ios: '1.0.0', android: '1.0.0' }));
    const renderer = await renderProbe();
    await flush();
    expect(textChildren(renderer)).toEqual(['false:false']);

    // A tRPC refusal flips the signal immediately.
    act(() => {
      reportTrpcError({ data: { upstreamCode: 'app_update_required' } });
    });
    expect(textChildren(renderer)).toEqual(['true:false']);

    // A successful up-to-date check clears the previously-set signal.
    currentTime = BASE_TIME + 30_000;
    act(() => {
      appState.emit('active');
    });
    await flush();
    expect(textChildren(renderer)).toEqual(['false:false']);
  });
});
