import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppStateActive } from '@/lib/hooks/use-app-state-active';

const appState = vi.hoisted(() => {
  const listeners = new Set<(state: string) => void>();
  return {
    listeners,
    currentState: null as string | null,
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

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: appState.addEventListener,
  },
}));

function Probe() {
  const active = useAppStateActive();
  return createElement('ProbeText', null, String(active));
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

describe('useAppStateActive mounted', () => {
  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    appState.currentState = 'active';
  });

  it('seeds a cold-start mount from a null currentState', () => {
    // The module-level store is constructed with `currentState === null`, so
    // the first mount must read not-active, exactly like the per-hook
    // `useState(AppState.currentState === 'active')` this replaces.
    expect(appState.currentState).toBeNull();

    const renderer = mountProbe();

    expect(appState.listeners.size).toBe(1);
    expect(textChildren(renderer)).toEqual(['false']);

    act(() => {
      appState.emit('active');
    });
    expect(textChildren(renderer)).toEqual(['true']);
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

    act(() => {
      appState.emit('inactive');
    });
    expect(textChildren(first)).toEqual(['false']);
    expect(textChildren(second)).toEqual(['false']);

    act(() => {
      appState.emit('active');
    });
    expect(textChildren(first)).toEqual(['true']);
    expect(textChildren(second)).toEqual(['true']);
  });

  it('removes the listener on the last unmount and re-reads the live state on remount', () => {
    const first = mountProbe();
    expect(textChildren(first)).toEqual(['true']);

    act(() => {
      appState.emit('background');
    });
    expect(textChildren(first)).toEqual(['false']);

    unmountProbe(first);
    expect(appState.listeners.size).toBe(0);

    const second = mountProbe();
    // A remount while backgrounded reads the live state, not a stale `true`.
    expect(textChildren(second)).toEqual(['false']);

    act(() => {
      appState.emit('active');
    });
    expect(textChildren(second)).toEqual(['true']);
  });

  it('seeds the first mount from the live state after a launch-time transition', () => {
    // Cold start: the module-level store was built while `currentState` was
    // null, so `active` is stale. Leave it stale and unsubscribed...
    const before = mountProbe();
    act(() => {
      appState.emit('background');
    });
    unmountProbe(before);
    expect(appState.listeners.size).toBe(0);

    // ...then the OS foregrounds the app while no source listener exists, so
    // nobody observes the inactive -> active edge. The first mount must seed
    // from the live value, or the chat provider stays gated off.
    appState.currentState = 'active';

    const after = mountProbe();
    expect(textChildren(after)).toEqual(['true']);
  });
});
