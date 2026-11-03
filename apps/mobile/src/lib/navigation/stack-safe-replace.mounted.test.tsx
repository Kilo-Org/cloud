import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useStackSafeReplace } from './stack-safe-replace';

type Route = { key: string; name: string };
type State = { routes: Route[]; index: number };

const pushMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const resetMock = vi.hoisted(() => vi.fn());

type Nav = { state: State; transitionEnd: (() => void) | undefined };

const nav = vi.hoisted<Nav>(() => ({ state: { routes: [], index: 0 }, transitionEnd: undefined }));

vi.mock('expo-router', () => ({
  useRouter: () => ({ push: pushMock, replace: replaceMock }),
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

let latestReplace: ((href: string) => void) | undefined = undefined;

function Harness() {
  const router = useStackSafeReplace();
  latestReplace = router.replace as (href: string) => void;
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

const TABS: Route = { key: 'tabs-1', name: '(tabs)' };
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

describe('useStackSafeReplace', () => {
  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    resetMock.mockReset();
    nav.transitionEnd = undefined;
    latestReplace = undefined;
    setStack([TABS, r('new-1', 'agent-chat/new')], 1);
  });

  it('pushes instead of replacing, so the stack never swaps both screens at once', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');

    // A literal `replace` is what crashes Android Fabric (KILO-APP-25).
    expect(replaceMock).not.toHaveBeenCalled();
    expect(pushMock).toHaveBeenCalledTimes(1);
    expect(pushMock).toHaveBeenCalledWith('/(app)/agent-chat/ses_1');
    // Nothing is removed yet: the push transition is still running.
    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('drops the source route once the push transition has ended', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);
    endTransition();

    expect(resetMock).toHaveBeenCalledTimes(1);
    // The end state is the one `replace` produces: the source route is gone and
    // the destination is focused, so back skips past it.
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [TABS, r('session-1', 'agent-chat/[session-id]')],
      index: 1,
    });

    unmount(renderer);
  });

  it('removes the route it started from, not another route of the same name', () => {
    setStack([r('new-1', 'agent-chat/new'), r('new-2', 'agent-chat/new')], 1);
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        r('new-1', 'agent-chat/new'),
        r('new-2', 'agent-chat/new'),
        r('session-1', 'agent-chat/[session-id]'),
      ],
      2
    );
    endTransition();

    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')],
      index: 1,
    });

    unmount(renderer);
  });

  it('is one-shot: an unrelated later transition does not touch the stack', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);
    endTransition();
    expect(resetMock).toHaveBeenCalledTimes(1);

    endTransition();
    expect(resetMock).toHaveBeenCalledTimes(1);

    unmount(renderer);
  });

  it('retires every replaced source when a second replace runs before the first transition ends', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);
    latestReplace?.('/(app)/agent-chat/ses_2');
    setStack(
      [
        TABS,
        r('new-1', 'agent-chat/new'),
        r('session-1', 'agent-chat/[session-id]'),
        r('session-2', 'agent-chat/[session-id]'),
      ],
      3
    );
    endTransition();

    // One cleanup retires both sources at once, so back skips past every
    // replaced screen — the end state a chain of `router.replace` would leave.
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [TABS, r('session-2', 'agent-chat/[session-id]')],
      index: 1,
    });

    unmount(renderer);
  });

  it('keeps working across chained replaces that each get their own transition', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);
    endTransition();
    expect(resetMock).toHaveBeenCalledTimes(1);

    latestReplace?.('/(app)/agent-chat/ses_2');
    setStack(
      [TABS, r('session-1', 'agent-chat/[session-id]'), r('session-2', 'agent-chat/[session-id]')],
      2
    );
    endTransition();

    expect(resetMock.mock.calls[1]?.[0]).toEqual({
      routes: [TABS, r('session-2', 'agent-chat/[session-id]')],
      index: 1,
    });

    unmount(renderer);
  });

  it('retires the sources still on the stack and skips ones that left another way', () => {
    setStack([r('new-1', 'agent-chat/new'), r('new-2', 'agent-chat/new')], 1);
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        r('new-1', 'agent-chat/new'),
        r('new-2', 'agent-chat/new'),
        r('session-1', 'agent-chat/[session-id]'),
      ],
      2
    );
    // The user backs out of the pushed screen and the source before the first
    // transition ends, so `new-2` and `session-1` both leave the stack.
    setStack([r('new-1', 'agent-chat/new')], 0);
    latestReplace?.('/(app)/agent-chat/ses_2');
    setStack([r('new-1', 'agent-chat/new'), r('session-2', 'agent-chat/[session-id]')], 1);
    endTransition();

    expect(resetMock).toHaveBeenCalledTimes(1);
    // `new-2` is gone, so only `new-1`, the source of the second replace, is
    // retired here; the reset leaves the pushed target focused.
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [r('session-2', 'agent-chat/[session-id]')],
      index: 0,
    });

    unmount(renderer);
  });

  it('does not remove a pending source that the ended transition focused again', () => {
    setStack([r('new-1', 'agent-chat/new')], 0);
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack([r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 1);
    // The user backed out before the push settled, so the transition that ends
    // is focused on the pending source itself: dropping it here would tear the
    // screen the user just navigated back to.
    setStack([r('new-1', 'agent-chat/new')], 0);
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('leaves the stack alone when the source route is already gone', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    // The user left another way, so `new-1` is no longer on the stack: a reset
    // here would drop a route the navigation never owned.
    setStack([TABS], 0);
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('leaves the stack alone when the source route is the only one left', () => {
    setStack([r('new-1', 'agent-chat/new')], 0);
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    endTransition();

    // Resetting to an empty route list would tear down the navigator.
    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });
});
