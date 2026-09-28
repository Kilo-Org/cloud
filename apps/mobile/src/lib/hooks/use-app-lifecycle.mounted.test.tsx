import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppLifecycle } from '@/lib/hooks/use-app-lifecycle';

const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    lastState: 'active' as string,
    addEventListener: (_event: string, listener: (state: string) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
    emit: (state: string): void => {
      appState.lastState = state;
      for (const listener of listeners) {
        listener(state);
      }
    },
  };
});

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));

function Probe() {
  const { isActive } = useAppLifecycle();
  return createElement('ProbeText', null, String(isActive));
}

function textChildren(renderer: TestRenderer.ReactTestRenderer): string[] | null {
  const json = renderer.toJSON();
  if (!json || Array.isArray(json)) {
    return null;
  }
  return json.children.filter((child): child is string => typeof child === 'string');
}

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

function mountProbe(): TestRenderer.ReactTestRenderer {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  act(() => {
    rendererRef.current = TestRenderer.create(createElement(Probe));
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

describe('useAppLifecycle mounted', () => {
  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    appState.lastState = 'active';
  });

  it('shares one AppState listener between two mounted probes', () => {
    const first = mountProbe();
    const second = mountProbe();

    expect(appState.listeners.size).toBe(1);
    expect(textChildren(first)).toEqual(['true']);
    expect(textChildren(second)).toEqual(['true']);

    act(() => {
      appState.emit('background');
    });

    expect(textChildren(first)).toEqual(['false']);
    expect(textChildren(second)).toEqual(['false']);
  });

  it('updates both probes on the background -> active transition', () => {
    const first = mountProbe();
    const second = mountProbe();

    act(() => {
      appState.emit('background');
    });
    expect(textChildren(first)).toEqual(['false']);
    expect(textChildren(second)).toEqual(['false']);

    act(() => {
      appState.emit('active');
    });
    expect(textChildren(first)).toEqual(['true']);
    expect(textChildren(second)).toEqual(['true']);
  });

  it('removes the AppState listener when the last probe unmounts', () => {
    const first = mountProbe();
    const second = mountProbe();

    unmountProbe(first);
    expect(appState.listeners.size).toBe(1);

    unmountProbe(second);
    expect(appState.listeners.size).toBe(0);
  });

  it('mounts a fresh probe at active even when the app is backgrounded', () => {
    const first = mountProbe();
    act(() => {
      appState.emit('background');
    });
    expect(textChildren(first)).toEqual(['false']);

    unmountProbe(first);
    expect(appState.lastState).toBe('background');

    const second = mountProbe();
    expect(textChildren(second)).toEqual(['true']);

    // The probe mounted while the app was already backgrounded, so `active` is
    // not a background -> active edge for it. That matches today's per-hook
    // `useState(true)`, which a backgrounded mount also started from.
    act(() => {
      appState.emit('active');
    });
    expect(textChildren(second)).toEqual(['true']);
  });
});
