import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';

import type * as NativeLinking from 'expo-router/build/fork/useLinking.native';
import { useThenable } from 'expo-router/build/fork/useThenable';
import * as React from 'react';
import TestRenderer, { act } from 'react-test-renderer';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const require = createRequire(import.meta.url);
const moduleExports = {};
const initialState = { routes: [{ name: 'index' }] };
const extractExpoPathFromURL = (_prefixes: string[], url: string) => url.replace('kiloapp://', '');

runInNewContext(
  readFileSync(require.resolve('expo-router/build/fork/useLinking.native.js'), 'utf8'),
  {
    exports: moduleExports,
    process,
    require: (id: string) => {
      switch (id) {
        case 'react': {
          return React;
        }
        case 'react-native': {
          return { Platform: { OS: 'android' } };
        }
        case 'expo-linking': {
          return {};
        }
        case './extractPathFromURL': {
          return { extractExpoPathFromURL };
        }
        case '../react-navigation/native': {
          return { useNavigationIndependentTree: () => false };
        }
        default: {
          throw new Error(`Unexpected router dependency: ${id}`);
        }
      }
    },
  }
);

const { useLinking } = moduleExports as typeof NativeLinking;
const prefixes: string[] = [];
const neverResolves = Promise.withResolvers<undefined>().promise;
let renderer: TestRenderer.ReactTestRenderer | undefined = undefined;

type HarnessProps = { linkPrefixes?: string[] };

function createHarness(initialURL: string | null | Promise<string | null>, suspend = false) {
  const onUnhandledLinking = vi.fn<(path: string | undefined) => void>();
  const onCommit = vi.fn();
  const getInitialURL = (): string | null | Promise<string | null> => initialURL;
  const getStateFromPath = vi.fn(() => initialState);
  const action = { type: 'NAVIGATE' as const, payload: { name: 'index' } };
  const getActionFromState = () => action;
  const navigation = {
    getRootState: () => ({
      key: 'root',
      index: 0,
      routeNames: ['index'],
      routes: [{ key: 'index', name: 'index' }],
      type: 'stack',
      stale: false as const,
    }),
    dispatch: vi.fn(),
    resetRoot: vi.fn(),
  };
  const listeners = new Set<(url: string) => void>();
  const subscribe = (listener: (url: string) => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  };
  const snapshots: ReturnType<typeof useThenable>[] = [];

  function NavigationContainer({ linkPrefixes = prefixes }: HarnessProps) {
    const ref = React.useRef<Partial<Parameters<typeof useLinking>[0]['current']>>(navigation);
    const { getInitialState } = useLinking(
      ref as Parameters<typeof useLinking>[0],
      { prefixes: linkPrefixes, getInitialURL, getStateFromPath, getActionFromState, subscribe },
      onUnhandledLinking
    );
    snapshots.push(useThenable(getInitialState));
    React.useEffect(() => {
      onCommit();
    }, []);
    if (suspend) {
      React.use(neverResolves);
    }
    return null;
  }

  return {
    NavigationContainer,
    onUnhandledLinking,
    onCommit,
    getStateFromPath,
    snapshots,
    listeners,
    navigation,
    action,
  };
}

async function renderHarness(
  NavigationContainer: React.ComponentType<HarnessProps>,
  linkPrefixes = prefixes
) {
  await act(() => {
    const tree = React.createElement(
      React.StrictMode,
      null,
      React.createElement(
        React.Suspense,
        { fallback: null },
        React.createElement(NavigationContainer, { linkPrefixes })
      )
    );
    if (renderer) {
      renderer.update(tree);
    } else {
      renderer = TestRenderer.create(tree);
    }
  });
}

describe('Expo Router native initial linking', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(async () => {
    await act(() => {
      renderer?.unmount();
    });
    renderer = undefined;
    vi.unstubAllGlobals();
  });

  it('does not update an initial render that has not mounted', async () => {
    const initialURL = Promise.withResolvers<string | null>();
    const harness = createHarness(initialURL.promise, true);
    await renderHarness(harness.NavigationContainer);
    expect(harness.onCommit).not.toHaveBeenCalled();

    await act(() => {
      initialURL.resolve('kiloapp:///');
    });

    expect(harness.onUnhandledLinking).not.toHaveBeenCalled();
  });

  it('preserves initial navigation and unhandled links after mounting', async () => {
    const initialURL = Promise.withResolvers<string | null>();
    const harness = createHarness(initialURL.promise);
    await renderHarness(harness.NavigationContainer);
    expect(harness.onCommit).toHaveBeenCalled();

    await act(() => {
      initialURL.resolve('kiloapp:///settings');
    });

    expect(harness.onUnhandledLinking).toHaveBeenCalledExactlyOnceWith('/settings');
    expect(harness.getStateFromPath).toHaveBeenCalledWith('/settings', undefined);
    expect(harness.snapshots.at(-1)).toEqual([true, initialState]);
  });

  it('ignores an initial URL that resolves after unmounting', async () => {
    const initialURL = Promise.withResolvers<string | null>();
    const harness = createHarness(initialURL.promise);
    await renderHarness(harness.NavigationContainer);
    await act(() => {
      renderer?.unmount();
    });
    renderer = undefined;

    await act(() => {
      initialURL.resolve('kiloapp:///settings');
    });

    expect(harness.onUnhandledLinking).not.toHaveBeenCalled();
  });

  it('keeps synchronous initial URLs ready on the first render', async () => {
    const harness = createHarness('kiloapp:///settings');
    await renderHarness(harness.NavigationContainer);

    expect(harness.snapshots[0]).toEqual([true, initialState]);
    expect(harness.onUnhandledLinking).toHaveBeenCalledWith('/settings');
  });

  it('does not report a null initial URL', async () => {
    const initialURL = Promise.withResolvers<string | null>();
    initialURL.resolve(null);
    const harness = createHarness(initialURL.promise);
    await renderHarness(harness.NavigationContainer);

    expect(harness.onUnhandledLinking).not.toHaveBeenCalled();
    expect(harness.snapshots.at(-1)).toEqual([true, undefined]);
  });

  it('reports an already resolved initial URL once after mounting', async () => {
    const initialURL = Promise.withResolvers<string | null>();
    initialURL.resolve('kiloapp:///settings');
    const harness = createHarness(initialURL.promise);
    await renderHarness(harness.NavigationContainer);

    expect(harness.onUnhandledLinking).toHaveBeenCalledExactlyOnceWith('/settings');
    expect(harness.snapshots.at(-1)).toEqual([true, initialState]);
  });

  it('handles warm links without replaying the initial URL on rerender', async () => {
    const initialURL = Promise.withResolvers<string | null>();
    initialURL.resolve('kiloapp:///settings');
    const harness = createHarness(initialURL.promise);
    await renderHarness(harness.NavigationContainer);
    expect(harness.listeners.size).toBe(1);
    harness.onUnhandledLinking.mockClear();

    await act(() => {
      for (const listener of harness.listeners) {
        listener('kiloapp:///profile');
      }
    });
    await renderHarness(harness.NavigationContainer, []);

    expect(harness.onUnhandledLinking).toHaveBeenCalledExactlyOnceWith('/profile');
    expect(harness.navigation.dispatch).toHaveBeenCalledExactlyOnceWith(harness.action);
    expect(harness.navigation.resetRoot).not.toHaveBeenCalled();
    expect(harness.listeners.size).toBe(1);
  });
});
