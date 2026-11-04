import { type Context, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { useRouteIsStackRoot } from './route-focus';

// The vendored contexts are plain `createContext(undefined)` in expo-router.
// Mocking them with contexts of this suite's own keeps a Node test off the build
// output of the app's navigation stack, and reading them back typed as
// `Context<unknown>` lets the harness pass fake navigation objects without
// unchecked assertions (same pattern as `picker-sheet.focus.mounted.test.tsx`).
const NAVIGATION_CONTEXT = 'expo-router/build/react-navigation/core/NavigationContext';
const NAVIGATION_ROUTE_CONTEXT = 'expo-router/build/react-navigation/core/NavigationProvider';

// `vi.mock` is hoisted above these constants, so its specifier stays literal.
vi.mock('expo-router/build/react-navigation/core/NavigationContext', async () => {
  const { createContext } = await import('react');
  return { NavigationContext: createContext<unknown>(undefined) };
});
vi.mock('expo-router/build/react-navigation/core/NavigationProvider', async () => {
  const { createContext } = await import('react');
  return { NavigationRouteContext: createContext<unknown>(undefined) };
});

const SHEET_KEY = 'merge:1';
const OVERVIEW_KEY = 'index:0';

const rendered: boolean[] = [];

function Harness(): ReactNode {
  rendered.push(useRouteIsStackRoot());
  return null;
}

type Options = {
  /** Route keys the stack state lists, or null for "there is no navigator". */
  routes: string[] | null;
  /** The key the calling screen reads from its route context. */
  routeKey?: string;
};

async function mount({ routes, routeKey = SHEET_KEY }: Options): Promise<boolean> {
  const navigation =
    routes === null
      ? undefined
      : { getState: () => ({ index: routes.length - 1, routes: routes.map(key => ({ key })) }) };
  const { NavigationContext } = (await import(NAVIGATION_CONTEXT)) as {
    NavigationContext: Context<unknown>;
  };
  const { NavigationRouteContext } = (await import(NAVIGATION_ROUTE_CONTEXT)) as {
    NavigationRouteContext: Context<unknown>;
  };
  rendered.length = 0;
  act(() => {
    TestRenderer.create(
      createElement(
        NavigationContext.Provider,
        { value: navigation },
        createElement(
          NavigationRouteContext.Provider,
          { value: { key: routeKey } },
          createElement(Harness)
        )
      )
    );
  });
  const [isStackRoot] = rendered;
  if (isStackRoot === undefined) {
    throw new Error('hook was not mounted');
  }
  return isStackRoot;
}

describe('useRouteIsStackRoot', () => {
  it('reports the sheet that is its stack\u2019s first screen', async () => {
    expect(await mount({ routes: [SHEET_KEY] })).toBe(true);
  });

  it('reports a sheet pushed over another screen', async () => {
    expect(await mount({ routes: [OVERVIEW_KEY, SHEET_KEY] })).toBe(false);
  });

  it('reports a push in flight, whose state does not list the sheet yet, as pushed', async () => {
    expect(await mount({ routes: [OVERVIEW_KEY] })).toBe(false);
  });

  it('reports the first screen when nothing above the surface provides navigation', async () => {
    expect(await mount({ routes: null })).toBe(true);
  });
});
