import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRepairTriggerRouteStack } from './use-repair-trigger-route-stack';

type Route = { key: string; name: string; params?: object };
type State = { routes: Route[]; index: number };

const pushMock = vi.hoisted(() => vi.fn());
const resetMock = vi.hoisted(() => vi.fn());

type Nav = {
  state: State;
  pathname: string;
  listeners: Set<() => void>;
};

const nav = vi.hoisted<Nav>(() => ({
  state: { routes: [], index: 0 },
  pathname: '/triggers/trigger-1',
  listeners: new Set(),
}));

vi.mock('expo-router', () => ({
  usePathname: () => nav.pathname,
  useRouter: () => ({ push: pushMock }),
  useNavigation: () => ({
    getState: () => nav.state,
    reset: resetMock,
    addListener: (_event: string, listener: () => void) => {
      nav.listeners.add(listener);
      return () => {
        nav.listeners.delete(listener);
      };
    },
  }),
}));

const LIST = 'triggers/index';
const DETAIL = 'triggers/[trigger-id]';
const SELF = '/(app)/(tabs)/(3_profile)/triggers/trigger-1?org=org-1';

function Harness() {
  useRepairTriggerRouteStack({
    self: SELF,
    organizationId: 'org-1',
  });
  return null;
}

function mount() {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness));
  });
  if (!ref.current) {
    throw new Error('harness did not render');
  }
  return ref.current;
}

function setStack(routes: Route[], index: number) {
  nav.state = { routes, index };
}

function endTransition() {
  act(() => {
    for (const listener of nav.listeners) {
      listener();
    }
  });
}

const r = (key: string, name: string, params?: object): Route => ({ key, name, params });

beforeEach(() => {
  pushMock.mockReset();
  resetMock.mockReset();
  nav.listeners.clear();
  nav.pathname = '/triggers/trigger-1';
});

describe('useRepairTriggerRouteStack', () => {
  it('pushes nothing when the triggers list is already beneath', () => {
    setStack([r('tabs', '(tabs)'), r('l', LIST), r('d', DETAIL)], 2);
    mount();

    expect(pushMock).not.toHaveBeenCalled();
    expect(resetMock).not.toHaveBeenCalled();
  });

  it('rebuilds the scoped list under a detail opened without it', () => {
    setStack([r('tabs', '(tabs)'), r('d', DETAIL)], 1);
    mount();

    expect(pushMock).toHaveBeenCalledTimes(2);
    expect(pushMock.mock.calls[0]?.[0]).toBe(
      '/(app)/(tabs)/(3_profile)/triggers?org=org-1&stackRebuilt=1'
    );
    expect(pushMock.mock.calls[1]?.[0]).toBe(
      '/(app)/(tabs)/(3_profile)/triggers/trigger-1?org=org-1&stackRebuilt=1'
    );
  });

  it('does not repair a route the focus check does not own', () => {
    setStack([r('tabs', '(tabs)'), r('d', 'profiles/[profileId]/index')], 1);
    mount();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('retires the original copy once its rebuilt copy has settled on top', () => {
    setStack([r('tabs', '(tabs)'), r('d', DETAIL)], 1);
    mount();
    expect(nav.listeners.size).toBeGreaterThan(0);
    expect(resetMock).not.toHaveBeenCalled();

    // The rebuilt copy is on top; the original is still in the middle.
    setStack(
      [
        r('tabs', '(tabs)'),
        r('d', DETAIL),
        r('l', LIST, { stackRebuilt: '1' }),
        r('d-rebuilt', DETAIL, { stackRebuilt: '1' }),
      ],
      3
    );
    endTransition();

    expect(resetMock).toHaveBeenCalledTimes(1);
    const [nextState] = resetMock.mock.calls[0] as [State];
    expect(nextState.routes.map(route => route.key)).toEqual(['tabs', 'l', 'd-rebuilt']);
    expect(nextState.index).toBe(2);
  });
});
