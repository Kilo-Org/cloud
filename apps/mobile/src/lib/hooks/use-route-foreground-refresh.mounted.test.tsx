/* eslint-disable typescript-eslint/no-deprecated -- react-test-renderer is the DOM-free renderer used to mount React/RN trees under vitest (same pattern as src/lib/hooks/use-force-update.mounted.test.tsx) */
import { createElement } from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useRouteForegroundRefresh } from '@/lib/hooks/use-route-foreground-refresh';

const invalidateQueries = vi.hoisted(() => vi.fn());

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

const focusState = vi.hoisted(() => ({
  isFocused: true,
}));

// Captures the useFocusEffect callback so a test can simulate a focus event.
const focusEffect = vi.hoisted(() => ({
  effect: undefined as (() => void) | undefined,
}));

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
}));

vi.mock('@tanstack/react-query', () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));

vi.mock('expo-router', () => ({
  useIsFocused: () => focusState.isFocused,
  useFocusEffect: (effect: () => void) => {
    focusEffect.effect = effect;
  },
}));

const KEYS: readonly (readonly unknown[])[] = [['securityAgent'], ['organizations']];

function Probe({ queryKeys }: { queryKeys: readonly (readonly unknown[])[] }) {
  useRouteForegroundRefresh(queryKeys);
  return createElement('ProbeText', null, 'probe');
}

const mountedRenderers: TestRenderer.ReactTestRenderer[] = [];

async function renderProbe(
  queryKeys: readonly (readonly unknown[])[]
): Promise<TestRenderer.ReactTestRenderer> {
  const rendererRef: { current: TestRenderer.ReactTestRenderer | undefined } = {
    current: undefined,
  };
  await act(async () => {
    await Promise.resolve();
    rendererRef.current = TestRenderer.create(createElement(Probe, { queryKeys }));
  });
  const renderer = rendererRef.current;
  if (!renderer) {
    throw new Error('renderer was not created');
  }
  mountedRenderers.push(renderer);
  return renderer;
}

function backgroundThenActive(): void {
  act(() => {
    appState.emit('background');
  });
  act(() => {
    appState.emit('active');
  });
}

describe('useRouteForegroundRefresh mounted', () => {
  beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    focusState.isFocused = true;
    focusEffect.effect = undefined;
    invalidateQueries.mockReset();
  });

  afterEach(() => {
    act(() => {
      for (const renderer of mountedRenderers) {
        renderer.unmount();
      }
    });
    mountedRenderers.length = 0;
    appState.listeners.clear();
    focusEffect.effect = undefined;
  });

  it('invalidates exactly the listed keys on the focused foreground transition', async () => {
    await renderProbe(KEYS);

    backgroundThenActive();

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['securityAgent'] });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['organizations'] });
  });

  it('invalidates nothing on the foreground transition while unfocused', async () => {
    focusState.isFocused = false;
    await renderProbe(KEYS);

    backgroundThenActive();

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates nothing on the first focus (mount)', async () => {
    await renderProbe(KEYS);

    act(() => {
      focusEffect.effect?.();
    });

    expect(invalidateQueries).not.toHaveBeenCalled();
  });

  it('invalidates the keys on a later focus regain', async () => {
    await renderProbe(KEYS);

    act(() => {
      focusEffect.effect?.();
    });
    expect(invalidateQueries).not.toHaveBeenCalled();

    act(() => {
      focusEffect.effect?.();
    });

    expect(invalidateQueries).toHaveBeenCalledTimes(2);
    expect(invalidateQueries).toHaveBeenNthCalledWith(1, { queryKey: ['securityAgent'] });
    expect(invalidateQueries).toHaveBeenNthCalledWith(2, { queryKey: ['organizations'] });
  });
});
