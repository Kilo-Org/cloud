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

describe('useStackSafeReplace', () => {
  beforeEach(() => {
    pushMock.mockReset();
    replaceMock.mockReset();
    resetMock.mockReset();
    nav.transitionEnd = undefined;
    latestReplace = undefined;
    setStack(
      [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'new-1', name: 'agent-chat/new' },
      ],
      1
    );
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

    act(() => {
      renderer.unmount();
    });
  });

  it('drops the source route once the push transition has ended', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      2
    );

    act(() => {
      nav.transitionEnd?.();
    });

    expect(resetMock).toHaveBeenCalledTimes(1);
    // The end state is the one `replace` produces: the source route is gone and
    // the destination is focused, so back skips past it.
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      index: 1,
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('removes the route it started from, not another route of the same name', () => {
    setStack(
      [
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'new-2', name: 'agent-chat/new' },
      ],
      1
    );
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'new-2', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      2
    );

    act(() => {
      nav.transitionEnd?.();
    });

    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      index: 1,
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('is one-shot: an unrelated later transition does not touch the stack', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      2
    );
    act(() => {
      nav.transitionEnd?.();
    });
    expect(resetMock).toHaveBeenCalledTimes(1);

    act(() => {
      nav.transitionEnd?.();
    });
    expect(resetMock).toHaveBeenCalledTimes(1);

    act(() => {
      renderer.unmount();
    });
  });

  it('retires every replaced source when a second replace runs before the first transition ends', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      2
    );
    latestReplace?.('/(app)/agent-chat/ses_2');
    setStack(
      [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
        { key: 'session-2', name: 'agent-chat/[session-id]' },
      ],
      3
    );

    act(() => {
      nav.transitionEnd?.();
    });

    // One cleanup retires both sources at once, so back skips past every
    // replaced screen — the end state a chain of `router.replace` would leave.
    expect(resetMock).toHaveBeenCalledTimes(1);
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'session-2', name: 'agent-chat/[session-id]' },
      ],
      index: 1,
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('keeps working across chained replaces that each get their own transition', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      2
    );
    act(() => {
      nav.transitionEnd?.();
    });
    expect(resetMock).toHaveBeenCalledTimes(1);

    latestReplace?.('/(app)/agent-chat/ses_2');
    setStack(
      [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
        { key: 'session-2', name: 'agent-chat/[session-id]' },
      ],
      2
    );
    act(() => {
      nav.transitionEnd?.();
    });

    expect(resetMock.mock.calls[1]?.[0]).toEqual({
      routes: [
        { key: 'tabs-1', name: '(tabs)' },
        { key: 'session-2', name: 'agent-chat/[session-id]' },
      ],
      index: 1,
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('retires the sources still on the stack and skips ones that left another way', () => {
    setStack(
      [
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'new-2', name: 'agent-chat/new' },
      ],
      1
    );
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'new-2', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      2
    );
    // The user backs out of the pushed screen and the source before the first
    // transition ends, so `new-2` and `session-1` both leave the stack.
    setStack([{ key: 'new-1', name: 'agent-chat/new' }], 0);
    latestReplace?.('/(app)/agent-chat/ses_2');
    setStack(
      [
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'session-2', name: 'agent-chat/[session-id]' },
      ],
      1
    );

    act(() => {
      nav.transitionEnd?.();
    });

    expect(resetMock).toHaveBeenCalledTimes(1);
    // `new-2` is gone, so only `new-1`, the source of the second replace, is
    // retired here; the reset leaves the pushed target focused.
    expect(resetMock.mock.calls[0]?.[0]).toEqual({
      routes: [{ key: 'session-2', name: 'agent-chat/[session-id]' }],
      index: 0,
    });

    act(() => {
      renderer.unmount();
    });
  });

  it('does not remove a pending source that the ended transition focused again', () => {
    setStack([{ key: 'new-1', name: 'agent-chat/new' }], 0);
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    setStack(
      [
        { key: 'new-1', name: 'agent-chat/new' },
        { key: 'session-1', name: 'agent-chat/[session-id]' },
      ],
      1
    );
    // The user backed out before the push settled, so the transition that ends
    // is focused on the pending source itself: dropping it here would tear the
    // screen the user just navigated back to.
    setStack([{ key: 'new-1', name: 'agent-chat/new' }], 0);

    act(() => {
      nav.transitionEnd?.();
    });

    expect(resetMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('leaves the stack alone when the source route is already gone', () => {
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');
    // The user left another way, so `new-1` is no longer on the stack: a reset
    // here would drop a route the navigation never owned.
    setStack([{ key: 'tabs-1', name: '(tabs)' }], 0);

    act(() => {
      nav.transitionEnd?.();
    });

    expect(resetMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });

  it('leaves the stack alone when the source route is the only one left', () => {
    setStack([{ key: 'new-1', name: 'agent-chat/new' }], 0);
    const renderer = mount();

    latestReplace?.('/(app)/agent-chat/ses_1');

    act(() => {
      nav.transitionEnd?.();
    });

    // Resetting to an empty route list would tear down the navigator.
    expect(resetMock).not.toHaveBeenCalled();

    act(() => {
      renderer.unmount();
    });
  });
});
