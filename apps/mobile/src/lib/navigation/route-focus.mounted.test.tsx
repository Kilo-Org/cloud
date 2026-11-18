import { type Context, createElement, type ReactNode } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { describe, expect, it, vi } from 'vitest';

import { useNavigationQueueSettled, useRouteIsStackRoot } from './route-focus';

// The vendored contexts are plain `createContext(...)` in expo-router. Mocking
// them with contexts of this suite's own keeps a Node test off the build output
// of the app's navigation stack, and reading them back typed as
// `Context<unknown>` lets the harness pass fake navigation objects without
// unchecked assertions (same pattern as `picker-sheet.focus.mounted.test.tsx`).
const NAVIGATION_CONTEXT = 'expo-router/build/react-navigation/core/NavigationContext';
const NAVIGATION_ROUTE_CONTEXT = 'expo-router/build/react-navigation/core/NavigationProvider';
const ROUTING_QUEUE_CONTEXT = 'expo-router/build/global-state/routingQueueContext';

// `vi.mock` is hoisted above these constants, so its specifier stays literal.
vi.mock('expo-router/build/react-navigation/core/NavigationContext', async () => {
  const { createContext } = await import('react');
  return { NavigationContext: createContext<unknown>(undefined) };
});
vi.mock('expo-router/build/react-navigation/core/NavigationProvider', async () => {
  const { createContext } = await import('react');
  return { NavigationRouteContext: createContext<unknown>(undefined) };
});
vi.mock('expo-router/build/global-state/routingQueueContext', async () => {
  const { createContext } = await import('react');
  return {
    NavigationPendingContext: createContext(false),
    RoutingQueueApiContext: createContext<unknown>(undefined),
  };
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

const settled: boolean[] = [];

function SettleHarness(): ReactNode {
  settled.push(useNavigationQueueSettled());
  return null;
}

type SettleOptions = {
  /** Whether `ExpoRoot`'s routing queue provider is above the caller. */
  queueApi: boolean;
  /** Whether the queue still carries a dispatched intent. */
  pending: boolean;
};

async function mountSettle({ queueApi, pending }: SettleOptions): Promise<boolean> {
  const { NavigationPendingContext, RoutingQueueApiContext } = (await import(
    ROUTING_QUEUE_CONTEXT
  )) as {
    NavigationPendingContext: Context<boolean>;
    RoutingQueueApiContext: Context<unknown>;
  };
  const screen = createElement(
    NavigationPendingContext.Provider,
    { value: pending },
    createElement(SettleHarness)
  );
  const tree = queueApi
    ? createElement(RoutingQueueApiContext.Provider, { value: {} }, screen)
    : screen;
  settled.length = 0;
  act(() => {
    TestRenderer.create(tree);
  });
  const [value] = settled;
  if (value === undefined) {
    throw new Error('hook was not mounted');
  }
  return value;
}

describe('useNavigationQueueSettled', () => {
  it('reports settled when nothing provides the routing queue', async () => {
    expect(await mountSettle({ queueApi: false, pending: false })).toBe(true);
    // A pending flag without the queue API cannot describe a dispatch, so the
    // hook must not read it as one.
    expect(await mountSettle({ queueApi: false, pending: true })).toBe(true);
  });

  it('reports a queue that still carries a dispatched intent', async () => {
    expect(await mountSettle({ queueApi: true, pending: true })).toBe(false);
  });

  it('reports the queue that drained the dispatched intent', async () => {
    expect(await mountSettle({ queueApi: true, pending: false })).toBe(true);
  });
});
