import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppActiveAndFocused } from '@/components/kilo-chat/hooks/use-app-active-and-focused';

type FocusEffectCallback = () => (() => void) | undefined;

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

const focus = vi.hoisted(() => ({
  callbacks: [] as FocusEffectCallback[],
}));

vi.mock('react-native', () => ({
  AppState: {
    get currentState() {
      return appState.currentState;
    },
    addEventListener: appState.addEventListener,
  },
}));

// The real hook uses expo-router's `useFocusEffect`; the mock records the
// focus callback so a test decides when the route becomes focused or blurs.
vi.mock('expo-router', () => ({
  useFocusEffect: (focusEffect: FocusEffectCallback) => {
    if (!focus.callbacks.includes(focusEffect)) {
      focus.callbacks.push(focusEffect);
    }
  },
}));

function FocusProbe() {
  const active = useAppActiveAndFocused();
  return createElement('FocusProbeText', null, String(active));
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
    rendererRef.current = TestRenderer.create(createElement(FocusProbe));
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

function focusProbes(): (() => void)[] {
  const cleanups: (() => void)[] = [];
  act(() => {
    for (const focusEffect of focus.callbacks) {
      const cleanup = focusEffect();
      if (typeof cleanup === 'function') {
        cleanups.push(cleanup);
      }
    }
  });
  return cleanups;
}

function blurProbes(cleanups: (() => void)[]): void {
  act(() => {
    for (const cleanup of cleanups) {
      cleanup();
    }
  });
}

describe('useAppActiveAndFocused mounted', () => {
  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    appState.currentState = 'active';
    focus.callbacks.length = 0;
  });

  it('holds one AppState listener and gates the value on route focus', () => {
    const first = mountProbe();
    const second = mountProbe();

    expect(appState.listeners.size).toBe(1);
    expect(textChildren(first)).toEqual(['false']);
    expect(textChildren(second)).toEqual(['false']);

    const cleanups = focusProbes();
    expect(textChildren(first)).toEqual(['true']);
    expect(textChildren(second)).toEqual(['true']);

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

    blurProbes(cleanups);
    expect(textChildren(first)).toEqual(['false']);
    expect(textChildren(second)).toEqual(['false']);
  });

  it('removes the AppState listener when the last consumer unmounts', () => {
    const first = mountProbe();
    const second = mountProbe();

    expect(appState.listeners.size).toBe(1);

    unmountProbe(first);
    expect(appState.listeners.size).toBe(1);

    unmountProbe(second);
    expect(appState.listeners.size).toBe(0);
  });
});
