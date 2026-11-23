import { createElement } from 'react';
import { act, TestRenderer } from '@/test/renderer';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type StackSafeReplaceRouter, useStackSafeReplace } from './stack-safe-replace';

type Route = { key: string; name: string };
type State = { routes: Route[]; index: number };

const pushMock = vi.hoisted(() => vi.fn());
const replaceMock = vi.hoisted(() => vi.fn());
const resetMock = vi.hoisted(() => vi.fn());

type Nav = {
  current: State;
  transitionEnd: (() => void) | undefined;
  stateListener: (() => void) | undefined;
};

const nav = vi.hoisted<Nav>(() => ({
  current: { routes: [], index: 0 },
  transitionEnd: undefined,
  stateListener: undefined,
}));

vi.mock('expo-router', () => {
  // Real expo-router returns the same router and navigator objects on every
  // render; a fresh object per call would defeat the memoisation under test.
  const router = { push: pushMock, replace: replaceMock };
  const navigation = {
    addListener: (event: string, listener: () => void) => {
      if (event !== 'transitionEnd' && event !== 'state') {
        return () => undefined;
      }
      // Each event owns its own slot, so one unsubscribe never clears the
      // other listener the hook registered.
      const slot = event === 'state' ? 'stateListener' : 'transitionEnd';
      nav[slot] = listener;
      return () => {
        nav[slot] = undefined;
      };
    },
    getState: () => nav.current,
    reset: resetMock,
  };
  return {
    useRouter: () => router,
    useNavigation: () => navigation,
  };
});

let latestRouter: StackSafeReplaceRouter | undefined = undefined;
let latestReplace: ((href: string) => void) | undefined = undefined;

function Harness() {
  const router = useStackSafeReplace();
  latestRouter = router;
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
  nav.current = { routes, index };
  // The real navigator emits `state` after every committed navigation, so the
  // hook observes the new stack through the listener as well as `getState`.
  act(() => {
    nav.stateListener?.();
  });
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
    nav.stateListener = undefined;
    latestRouter = undefined;
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

    // The cleanup the assertion above saw is applied before the next replace.
    setStack([TABS, r('session-1', 'agent-chat/[session-id]')], 1);
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

  it('ignores a transition that ends before the push commits, then retires on the real one', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    // The screen's own arrival event was still in flight and lands now: the
    // stack has not gained the pushed route yet, so this end belongs to the
    // navigation that opened the source, not to the push.
    endTransition();
    expect(resetMock).not.toHaveBeenCalled();

    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);
    endTransition();

    // The end of the real push still retires the source, so Back skips it.
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [TABS, r('session-1', 'agent-chat/[session-id]')],
      index: 1,
    });

    unmount(renderer);
  });

  it('does not retire the source when a later push lands after a lost push end', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    // The push commits, but its `transitionEnd` never arrives.
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);

    // The reader pops back to the source; that pop ends normally. The source is
    // pending, but judging it by depth alone would leave it waiting for an end
    // that already happened.
    setStack([TABS, r('new-1', 'agent-chat/new')], 1);
    endTransition();
    expect(resetMock).not.toHaveBeenCalled();

    // A push from the source reaches the old depth again. Retiring the source
    // here would remove the screen the reader is on.
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-2', 'agent-chat/[session-id]')], 2);
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('forgets the source when the committed stack falls back, even without a pop end', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    // The push commits and the navigator shows the pushed route, so the source
    // is in its `pushed` phase.
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);

    // The reader pops back to the source, but that pop's `transitionEnd` never
    // arrives. The state alone says the pushed route is gone.
    setStack([TABS, r('new-1', 'agent-chat/new')], 1);

    // A later push from the source reaching the old depth must not retire the
    // source: the pending entry was already forgotten.
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-2', 'agent-chat/[session-id]')], 2);
    endTransition();

    expect(resetMock).not.toHaveBeenCalled();

    unmount(renderer);
  });

  it('still retires the source when the pushed route supersedes itself in place', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    // The push commits.
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);
    // The pushed screen redirects before the transition ends: the route at the
    // pushed depth now has another key, and the stack did not grow or shrink.
    setStack([TABS, r('new-1', 'agent-chat/new'), r('session-2', 'agent-chat/[session-id]')], 2);
    endTransition();

    // Tracking the pushed route by key would have forgotten the source here,
    // leaving the replaced screen in the stack for good.
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [TABS, r('session-2', 'agent-chat/[session-id]')],
      index: 1,
    });

    unmount(renderer);
  });

  it('stops tracking a source whose push never settled instead of retiring it later', () => {
    const now = vi.spyOn(Date, 'now');
    try {
      now.mockReturnValue(1_000);
      const renderer = mount();

      latestReplace?.('/(app)/agent-chat/ses_1');
      // The push never ended, so the source stays put. A much later transition
      // must not retire it: by then the reader may be using that screen.
      now.mockReturnValue(60_000);
      setStack([TABS, r('new-1', 'agent-chat/new'), r('session-1', 'agent-chat/[session-id]')], 2);
      endTransition();

      expect(resetMock).not.toHaveBeenCalled();

      unmount(renderer);
    } finally {
      now.mockRestore();
    }
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

  it('returns the same object across renders, so callers can hold it in a dependency array', () => {
    const renderer = mount();
    const first = latestRouter;
    if (!first) {
      throw new Error('harness did not capture the router');
    }

    // An unrelated re-render must not hand callers a new `{ replace }`: the
    // converted call sites keep this object in effect dependency arrays, and a
    // fresh object on every render would rebuild their callbacks and
    // re-subscribe their effects.
    act(() => {
      renderer.update(createElement(Harness));
    });

    expect(latestRouter).toBe(first);
    expect(latestRouter?.replace).toBe(first.replace);

    // The memoised object still replaces the way it did before.
    latestRouter?.replace('/(app)/agent-chat/ses_1');
    expect(pushMock).toHaveBeenCalledExactlyOnceWith('/(app)/agent-chat/ses_1');

    unmount(renderer);
  });
});
