import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRepairProfileRouteStack } from './use-repair-profile-route-stack';

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
  pathname: '/profile-management/profile-1/agents',
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

const LIST = 'profile-management/index';
const OVERVIEW = 'profile-management/[profileId]/index';
const AGENTS = 'profile-management/[profileId]/agents';
const SELF = '/(app)/profile-management/profile-1/agents?organizationId=org-1';

function Harness() {
  useRepairProfileRouteStack({
    profileId: 'profile-1',
    organizationId: 'org-1',
    parents: { list: true, overview: true },
    self: SELF,
    stack: 'app',
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
  nav.pathname = '/profile-management/profile-1/agents';
});

describe('useRepairProfileRouteStack', () => {
  it('pushes nothing when the list and the overview are already beneath', () => {
    setStack([r('tabs', '(tabs)'), r('l', LIST), r('o', OVERVIEW), r('a', AGENTS)], 3);
    mount();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('leaves a screen an outside app screen opened on purpose', () => {
    // An agent session opens the profile of its own organization: Back returns
    // to the session, so the profile tree is never built under it.
    setStack(
      [
        r('tabs', '(tabs)'),
        r('session', 'agent-chat/[session-id]'),
        r('o', OVERVIEW, { openedFrom: 'session' }),
      ],
      2
    );
    mount();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('repairs a link delivered over another app screen', () => {
    // A link arriving while the composer is open is not the composer opening a
    // profile: it gets the profile screens, so Back does not leave the tree.
    setStack([r('tabs', '(tabs)'), r('new', 'agent-chat/new'), r('a', AGENTS)], 2);
    mount();

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/profile-management?stackRebuilt=1',
      '/(app)/profile-management/profile-1?organizationId=org-1&stackRebuilt=1',
      `${SELF}&stackRebuilt=1`,
    ]);
  });

  it('rebuilds the list and the overview under a section that arrived alone', () => {
    setStack([r('tabs', '(tabs)'), r('a', AGENTS)], 1);
    mount();

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/profile-management?stackRebuilt=1',
      '/(app)/profile-management/profile-1?organizationId=org-1&stackRebuilt=1',
      `${SELF}&stackRebuilt=1`,
    ]);
  });

  it('pushes only the overview when the list is already beneath', () => {
    setStack([r('tabs', '(tabs)'), r('l', LIST), r('a', AGENTS)], 2);
    mount();

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/profile-management/profile-1?organizationId=org-1&stackRebuilt=1',
      `${SELF}&stackRebuilt=1`,
    ]);
  });

  it('never repairs a screen the repair itself pushed', () => {
    setStack([r('tabs', '(tabs)'), r('a', AGENTS, { stackRebuilt: '1' })], 1);
    mount();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('retires the original copy once its rebuilt copy has settled on top', () => {
    setStack([r('tabs', '(tabs)'), r('a', AGENTS)], 1);
    mount();
    expect(nav.listeners.size).toBeGreaterThan(0);
    expect(resetMock).not.toHaveBeenCalled();

    // The rebuilt copy is on top; the original is still in the middle.
    setStack(
      [
        r('tabs', '(tabs)'),
        r('a', AGENTS),
        r('l', LIST, { stackRebuilt: '1' }),
        r('o', OVERVIEW, { stackRebuilt: '1' }),
        r('a-rebuilt', AGENTS, { stackRebuilt: '1' }),
      ],
      4
    );
    endTransition();

    expect(resetMock).toHaveBeenCalledTimes(1);
    const [nextState] = resetMock.mock.calls[0] as [State];
    expect(nextState.routes.map(route => route.key)).toEqual(['tabs', 'l', 'o', 'a-rebuilt']);
    expect(nextState.index).toBe(3);
  });

  it('retires the original copy as soon as the rebuilt copy is on top, with no transition to wait for', () => {
    setStack([r('tabs', '(tabs)'), r('a', AGENTS)], 1);
    mount();

    // The rebuilt push carries no animation, so the state event is the only
    // signal the retirement gets.
    setStack(
      [
        r('tabs', '(tabs)'),
        r('a', AGENTS),
        r('l', LIST, { stackRebuilt: '1' }),
        r('o', OVERVIEW, { stackRebuilt: '1' }),
        r('a-rebuilt', AGENTS, { stackRebuilt: '1' }),
      ],
      4
    );
    act(() => {
      for (const listener of nav.listeners) {
        listener();
      }
    });

    expect(resetMock).toHaveBeenCalledTimes(1);
    const [nextState] = resetMock.mock.calls[0] as [State];
    expect(nextState.routes.map(route => route.key)).toEqual(['tabs', 'l', 'o', 'a-rebuilt']);
  });

  it('retires nothing twice when the reset is already applied', () => {
    setStack([r('tabs', '(tabs)'), r('a', AGENTS)], 1);
    mount();

    setStack([r('tabs', '(tabs)'), r('a-rebuilt', AGENTS, { stackRebuilt: '1' })], 1);
    act(() => {
      for (const listener of nav.listeners) {
        listener();
      }
    });

    expect(resetMock).not.toHaveBeenCalled();
  });

  it('keeps the original copy while its own rebuilt copy is not on top yet', () => {
    setStack([r('tabs', '(tabs)'), r('a', AGENTS)], 1);
    mount();

    setStack(
      [r('tabs', '(tabs)'), r('a', AGENTS), r('l', LIST, { stackRebuilt: '1' })],
      2
    );
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();
  });

  it('retires nothing when the original left the stack some other way', () => {
    setStack([r('tabs', '(tabs)'), r('a', AGENTS)], 1);
    mount();

    setStack([r('tabs', '(tabs)'), r('a-rebuilt', AGENTS, { stackRebuilt: '1' })], 1);
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();
  });

  it('builds the parents of a screen that is the only route of its Stack', () => {
    setStack([r('a', AGENTS)], 0);
    mount();

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/profile-management?stackRebuilt=1',
      '/(app)/profile-management/profile-1?organizationId=org-1&stackRebuilt=1',
      `${SELF}&stackRebuilt=1`,
    ]);
  });

  it('pushes no overview for a screen that carries no profile id', () => {
    setStack([r('tabs', '(tabs)'), r('new', 'profile-management/new')], 1);
    nav.pathname = '/profile-management/new';
    function NoProfileHarness() {
      useRepairProfileRouteStack({
        parents: { list: true, overview: false },
        self: '/(app)/profile-management/new',
        stack: 'app',
      });
      return null;
    }
    act(() => {
      TestRenderer.create(createElement(NoProfileHarness));
    });

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/profile-management?stackRebuilt=1',
      '/(app)/profile-management/new?stackRebuilt=1',
    ]);
  });
});