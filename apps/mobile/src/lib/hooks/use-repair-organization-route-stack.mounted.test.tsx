import { type Href } from 'expo-router';
import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRepairOrganizationRouteStack } from './use-repair-organization-route-stack';

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
  pathname: '/organization/guardrails',
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

const HUB = 'index';
const GUARDRAILS = 'guardrails';
const SELF = '/(app)/(tabs)/(3_profile)/organization/guardrails';
const MODE_FORM = 'mode-form';
const MODE_FORM_PATH = '/(app)/(tabs)/(3_profile)/organization/mode-form';

function Harness({ self }: Readonly<{ self: Href }>) {
  useRepairOrganizationRouteStack({ self });
  return null;
}

function mount(self: Href = SELF) {
  const ref: { current: TestRenderer.ReactTestRenderer | undefined } = { current: undefined };
  act(() => {
    ref.current = TestRenderer.create(createElement(Harness, { self }));
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
  nav.pathname = '/organization/guardrails';
});

describe('useRepairOrganizationRouteStack', () => {
  it('pushes nothing when the hub is already beneath', () => {
    setStack([r('tabs', '(tabs)'), r('h', HUB), r('g', GUARDRAILS)], 2);
    mount();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('rebuilds the hub under a screen that arrived alone', () => {
    setStack([r('tabs', '(tabs)'), r('g', GUARDRAILS)], 1);
    mount();

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/(tabs)/(3_profile)/organization?stackRebuilt=1',
      `${SELF}?stackRebuilt=1`,
    ]);
  });

  it('repairs a link delivered over another screen of the tab', () => {
    setStack([r('tabs', '(tabs)'), r('p', 'profiles/index'), r('g', GUARDRAILS)], 2);
    mount();

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/(tabs)/(3_profile)/organization?stackRebuilt=1',
      `${SELF}?stackRebuilt=1`,
    ]);
  });

  it('keeps the opened record on the rebuilt push', () => {
    const self: Href = `${MODE_FORM_PATH}?modeId=mode-1`;
    setStack([r('tabs', '(tabs)'), r('m', MODE_FORM)], 1);
    nav.pathname = '/organization/mode-form';

    mount(self);

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/(tabs)/(3_profile)/organization?stackRebuilt=1',
      `${MODE_FORM_PATH}?modeId=mode-1&stackRebuilt=1`,
    ]);
  });

  it('never repairs a screen the repair itself pushed', () => {
    setStack([r('tabs', '(tabs)'), r('g', GUARDRAILS, { stackRebuilt: '1' })], 1);
    mount();

    expect(pushMock).not.toHaveBeenCalled();
  });

  it('retires the original copy once its rebuilt copy has settled on top', () => {
    setStack([r('tabs', '(tabs)'), r('g', GUARDRAILS)], 1);
    mount();
    expect(nav.listeners.size).toBeGreaterThan(0);
    expect(resetMock).not.toHaveBeenCalled();

    setStack(
      [
        r('tabs', '(tabs)'),
        r('g', GUARDRAILS),
        r('h', HUB, { stackRebuilt: '1' }),
        r('g-rebuilt', GUARDRAILS, { stackRebuilt: '1' }),
      ],
      3
    );
    endTransition();

    expect(resetMock).toHaveBeenCalledTimes(1);
    const [nextState] = resetMock.mock.calls[0] as [State];
    expect(nextState.routes.map(route => route.key)).toEqual(['tabs', 'h', 'g-rebuilt']);
    expect(nextState.index).toBe(2);
  });

  it('retires nothing when the rebuilt copy is not on top yet', () => {
    setStack([r('tabs', '(tabs)'), r('g', GUARDRAILS)], 1);
    mount();

    setStack([r('tabs', '(tabs)'), r('g', GUARDRAILS), r('h', HUB, { stackRebuilt: '1' })], 2);
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();
  });

  it('retires nothing twice when the reset is already applied', () => {
    setStack([r('tabs', '(tabs)'), r('g', GUARDRAILS)], 1);
    mount();

    setStack([r('tabs', '(tabs)'), r('g-rebuilt', GUARDRAILS, { stackRebuilt: '1' })], 1);
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();
  });

  it('builds the hub for a screen that is the only route of its Stack', () => {
    setStack([r('g', GUARDRAILS)], 0);
    mount();

    expect(pushMock.mock.calls.map(call => call[0])).toEqual([
      '/(app)/(tabs)/(3_profile)/organization?stackRebuilt=1',
      `${SELF}?stackRebuilt=1`,
    ]);
  });
});

describe('useRepairOrganizationRouteStack — cleanup', () => {
  it('removes both listeners when the screen unmounts', () => {
    setStack([r('tabs', '(tabs)'), r('g', GUARDRAILS)], 1);
    const renderer = mount();
    expect(nav.listeners.size).toBeGreaterThan(0);

    act(() => {
      renderer.unmount();
    });

    expect(nav.listeners.size).toBe(0);
  });
});
