import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useRetireCoveredSource } from './retire-covered-source';

type Route = { key: string; name: string };
type State = { routes: Route[]; index: number };

const resetMock = vi.hoisted(() => vi.fn());

// The navigator the hook reads and dispatches to. The suite moves the stack by
// hand, the way a push, a scene repair or a settle would.
const nav = vi.hoisted<{ state: State; transitionEnd: (() => void) | undefined }>(() => ({
  state: { routes: [], index: 0 },
  transitionEnd: undefined,
}));

vi.mock('expo-router', () => ({
  useNavigation: () => ({
    addListener: (event: string, listener: () => void) => {
      if (event === 'transitionEnd') {
        nav.transitionEnd = listener;
      }
      return () => {
        nav.transitionEnd = undefined;
      };
    },
    getState: () => nav.state,
    reset: resetMock,
  }),
}));

// The pair the security-agent findings list hands the hook: the finding detail
// that swapped in the list, guarded by the scope dashboard.
function Harness() {
  useRetireCoveredSource('findings/[id]', 'index');
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

const r = (key: string, name: string): Route => ({ key, name });

function endTransition() {
  act(() => {
    nav.transitionEnd?.();
  });
}

function unmount(renderer: TestRenderer.ReactTestRenderer) {
  act(() => {
    renderer.unmount();
  });
}

describe('useRetireCoveredSource', () => {
  beforeEach(() => {
    resetMock.mockReset();
    nav.transitionEnd = undefined;
    setStack([r('tabs-1', '(tabs)')], 0);
  });

  it('retires a source the hand-off left directly beneath the destination', () => {
    const dashboard = r('dash-1', 'index');
    const detail = r('detail-1', 'findings/[id]');
    const list = r('list-1', 'findings/index');
    setStack([r('tabs-1', '(tabs)'), dashboard, detail, list], 3);
    const renderer = mount();

    expect(resetMock).toHaveBeenCalledTimes(1);
    // The detail is gone, the destination is focused, and every surviving route
    // keeps its key.
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [r('tabs-1', '(tabs)'), dashboard, list],
      index: 2,
    });

    unmount(renderer);
  });

  it('retires a source the scene repair left below the guard and above nothing', () => {
    // A detail opened with no local history holds the whole stack, so the push
    // of the list lands on `[findings/[id], findings/index]`; the list's own
    // scene repair then splices the dashboard directly beneath the focused
    // route. The detail is two below the destination with the guard between.
    const detail = r('detail-1', 'findings/[id]');
    const dashboard = r('detail-1:index', 'index');
    const list = r('list-1', 'findings/index');
    setStack([detail, dashboard, list], 2);
    const renderer = mount();

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(resetMock.mock.calls[0]?.[0]).toEqual({ routes: [dashboard, list], index: 1 });

    unmount(renderer);
  });

  it('leaves the stack alone when a screen sits between the source and its guard', () => {
    setStack(
      [
        r('detail-1', 'findings/[id]'),
        r('dismiss-1', 'findings/dismiss/[id]'),
        r('dash-1', 'index'),
        r('list-1', 'findings/index'),
      ],
      3
    );
    const renderer = mount();
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('leaves the stack alone when a screen sits between the source and the destination', () => {
    // The destination did not land on that hand-off, so nothing moves.
    setStack(
      [
        r('dash-1', 'index'),
        r('detail-1', 'findings/[id]'),
        r('filter-1', 'filter'),
        r('list-1', 'findings/index'),
      ],
      3
    );
    const renderer = mount();
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('leaves the stack alone when the guard is missing beneath the source', () => {
    setStack([r('detail-1', 'findings/[id]'), r('list-1', 'findings/index')], 1);
    const renderer = mount();
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('judges once per mount, on the transition end and not again', () => {
    // The screen mounts on a stack it does not recognize, then the push settles
    // into the shape the hand-off produces.
    setStack([r('dash-1', 'index'), r('list-1', 'findings/index')], 1);
    const renderer = mount();
    expect(resetMock).not.toHaveBeenCalled();

    setStack(
      [
        r('detail-1', 'findings/[id]'),
        r('dash-1', 'index'),
        r('list-1', 'findings/index'),
      ],
      2
    );
    endTransition();
    endTransition();

    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [r('dash-1', 'index'), r('list-1', 'findings/index')],
      index: 1,
    });

    unmount(renderer);
  });

  it('leaves a stack whose focused route is the source itself alone', () => {
    setStack([r('dash-1', 'index'), r('detail-1', 'findings/[id]')], 1);
    const renderer = mount();
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });
});
