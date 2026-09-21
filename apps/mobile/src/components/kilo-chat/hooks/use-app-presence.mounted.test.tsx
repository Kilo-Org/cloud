import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppPresence } from '@/components/kilo-chat/hooks/use-app-presence';

const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    currentState: 'active' as string | null,
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (state: string): void => {
      appState.currentState = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

const mocks = vi.hoisted(() => ({
  presenceContextForPlatform: vi.fn((platform: string) => ({ platform })),
  usePresenceSubscription: vi.fn(),
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: appState.addEventListener,
  },
}));

vi.mock('@kilocode/event-service', () => ({
  presenceContextForPlatform: mocks.presenceContextForPlatform,
}));

vi.mock('@kilocode/kilo-chat-hooks', () => ({
  usePresenceSubscription: mocks.usePresenceSubscription,
}));

function PresenceProbe() {
  useAppPresence();
  return createElement('PresenceProbeText', null, 'presence');
}

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

function mountProbe(): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(createElement(PresenceProbe));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

function unmountProbe(renderer: TestRenderer.ReactTestRenderer): void {
  act(() => {
    renderer.unmount();
  });
  const index = mountedRenderers.indexOf(renderer);
  if (index !== -1) {
    mountedRenderers.splice(index, 1);
  }
}

describe('useAppPresence mounted', () => {
  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    appState.currentState = 'active';
    vi.clearAllMocks();
  });

  it('holds one AppState listener between two mounted consumers', () => {
    const first = mountProbe();
    const second = mountProbe();

    expect(appState.listeners.size).toBe(1);
    expect(mocks.presenceContextForPlatform).toHaveBeenCalledWith('app');
    expect(mocks.usePresenceSubscription).toHaveBeenNthCalledWith(1, { platform: 'app' }, true);
    expect(mocks.usePresenceSubscription).toHaveBeenNthCalledWith(2, { platform: 'app' }, true);

    act(() => {
      appState.emit('background');
    });
    expect(mocks.usePresenceSubscription).toHaveBeenLastCalledWith({ platform: 'app' }, false);

    act(() => {
      appState.emit('active');
    });
    expect(mocks.usePresenceSubscription).toHaveBeenLastCalledWith({ platform: 'app' }, true);

    unmountProbe(first);
    expect(appState.listeners.size).toBe(1);

    unmountProbe(second);
    expect(appState.listeners.size).toBe(0);
  });
});
