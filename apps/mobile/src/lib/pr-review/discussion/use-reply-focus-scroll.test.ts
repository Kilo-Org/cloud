// Unit coverage for the keyboard-open reply-focus scroll: the focused thread
// row must be scrolled above the keyboard-lifted bottom CTA bar exactly once
// per focus — against the COMMITTED viewport, never a guessed frame — and a
// user drag must win over the parked scroll.
//
// The CTA bar's keyboard lift lands asynchronously and SHRINKS the list
// viewport. The earlier one-frame guess after `keyboardDidShow` parked the
// row against the pre-lift viewport when the lift committed later, leaving
// the submit button behind the bar (uxs3 spot check, e7-typed). Platforms
// commit in opposite orders (iOS: lift before didShow; Android: lift after),
// so the suite drives both orders through the viewport-layout channel.
//
// The hook is mounted by calling it as a plain function with stubbed React
// primitives (the same pattern as pr-conversation-comment-composer.test.tsx):
// one ref/effect/callback slot per hook slot, effects run immediately and
// collect their cleanups. The node environment has no rAF, so a synchronous
// requestAnimationFrame stub stands in for the one-frame defer.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useReplyFocusScroll } from './use-reply-focus-scroll';

const keyboardSubscribers = vi.hoisted(() => ({
  show: null as (() => void) | null,
  hide: null as (() => void) | null,
}));

// No Platform in the react-native mock: the hook has one implementation for
// both platforms (the did-events fire everywhere), so any platform fork
// would crash here instead of passing silently on the mocked OS.
vi.mock('react-native', () => ({
  Keyboard: {
    addListener: vi.fn((event: string, listener: () => void) => {
      const remove = (): void => {
        if (event === 'keyboardDidShow') {
          keyboardSubscribers.show = null;
        }
        if (event === 'keyboardDidHide') {
          keyboardSubscribers.hide = null;
        }
      };
      if (event === 'keyboardDidShow') {
        keyboardSubscribers.show = listener;
      }
      if (event === 'keyboardDidHide') {
        keyboardSubscribers.hide = listener;
      }
      return { remove };
    }),
  },
}));

type ScrollToIndex = (params: { index: number; viewPosition: number; animated: boolean }) => void;

// The React-primitive slots are generic over the hook's actual call order
// (four useRef, one useEffect, four useCallback); the mock hands out slots on
// demand, so a hook refactor that reorders refs does not silently misalign.
const slots = {
  refs: [] as { current: unknown }[],
  refCursor: 0,
  cleanups: [] as (() => void)[],
};

vi.mock('react', () => ({
  useRef: (initial: unknown) => {
    if (slots.refs.length <= slots.refCursor) {
      slots.refs.push({ current: initial });
    }
    const slot = slots.refs[slots.refCursor];
    slots.refCursor += 1;
    return slot;
  },
  useEffect: (effect: () => unknown) => {
    const cleanup = effect();
    if (typeof cleanup === 'function') {
      slots.cleanups.push(cleanup as () => void);
    }
  },
  useCallback: <T extends (...args: never[]) => unknown>(factory: T): T => factory,
}));

type Mounted = {
  markFocus: (index: number) => void;
  onViewportLayout: (height: number) => void;
  invalidate: () => void;
  scrollToIndex: ReturnType<typeof vi.fn>;
  unmount: () => void;
};

function mountHook(): Mounted {
  slots.refs = [];
  slots.refCursor = 0;
  slots.cleanups = [];
  const scrollToIndex = vi.fn<ScrollToIndex>();
  const listRef = { current: { scrollToIndex } };
  // Property container, not a bare `let`: the hook's return is assigned
  // inside Harness, and control-flow narrowing of a bare variable would
  // type it as the initial `undefined` at the spread below.
  const produced: { current: ReturnType<typeof useReplyFocusScroll> | undefined } = {
    current: undefined,
  };
  function Harness(): null {
    produced.current = useReplyFocusScroll(
      listRef as unknown as Parameters<typeof useReplyFocusScroll>[0]
    );
    return null;
  }
  // eslint-disable-next-line new-cap -- plain-function mount of the hook harness
  Harness();
  if (!produced.current) {
    throw new Error('hook produced no surface');
  }
  return {
    ...produced.current,
    scrollToIndex,
    unmount: () => {
      for (const cleanup of slots.cleanups.splice(0)) {
        cleanup();
      }
    },
  };
}

describe('useReplyFocusScroll', () => {
  beforeEach(() => {
    keyboardSubscribers.show = null;
    keyboardSubscribers.hide = null;
    vi.stubGlobal('requestAnimationFrame', (onFrame: FrameRequestCallback) => {
      onFrame(0);
      return 0;
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('arms the keyboard show and hide listeners', () => {
    const { unmount } = mountHook();
    expect(keyboardSubscribers.show).toBeTypeOf('function');
    expect(keyboardSubscribers.hide).toBeTypeOf('function');
    unmount();
    expect(keyboardSubscribers.show).toBeNull();
    expect(keyboardSubscribers.hide).toBeNull();
  });

  it('Android order: scrolls on the post-show viewport commit, not on the show event itself', () => {
    const { markFocus, onViewportLayout, scrollToIndex, unmount } = mountHook();
    // The unlifted baseline the list reports at mount.
    onViewportLayout(600);
    markFocus(4);
    expect(scrollToIndex).not.toHaveBeenCalled();

    // The Android lift commits AFTER keyboardDidShow: the show event alone
    // must not scroll (that is the e7-typed defect — parking against the
    // pre-lift viewport leaves the submit button behind the lifted CTA).
    keyboardSubscribers.show?.();
    expect(scrollToIndex).not.toHaveBeenCalled();

    onViewportLayout(300);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 4, viewPosition: 1, animated: false });

    // One focus arms exactly one scroll: later events are inert.
    keyboardSubscribers.show?.();
    onViewportLayout(280);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('iOS order: scrolls on keyboardDidShow when the lift already committed', () => {
    const { markFocus, onViewportLayout, scrollToIndex, unmount } = mountHook();
    onViewportLayout(600);
    markFocus(4);
    expect(scrollToIndex).not.toHaveBeenCalled();

    // The iOS lift (keyboardWillShow padding) commits while the keyboard is
    // still animating in: the commit arms the scroll, didShow runs it.
    onViewportLayout(300);
    expect(scrollToIndex).not.toHaveBeenCalled();

    keyboardSubscribers.show?.();
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 4, viewPosition: 1, animated: false });
    unmount();
  });

  it('scrolls immediately for a focus that lands while the keyboard is already open', () => {
    const { markFocus, onViewportLayout, scrollToIndex, unmount } = mountHook();
    onViewportLayout(600);
    keyboardSubscribers.show?.();
    onViewportLayout(300);
    expect(scrollToIndex).not.toHaveBeenCalled();

    // The viewport is committed; a second reply field needs no event.
    markFocus(2);
    expect(scrollToIndex).toHaveBeenCalledWith({ index: 2, viewPosition: 1, animated: false });
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('ignores viewport commits and show events when no reply is focused', () => {
    const { onViewportLayout, scrollToIndex, unmount } = mountHook();
    onViewportLayout(600);
    keyboardSubscribers.show?.();
    onViewportLayout(300);
    keyboardSubscribers.show?.();
    expect(scrollToIndex).not.toHaveBeenCalled();
    unmount();
  });

  it('treats a same-height re-layout as no viewport change', () => {
    const { markFocus, onViewportLayout, scrollToIndex, unmount } = mountHook();
    onViewportLayout(600);
    markFocus(4);
    keyboardSubscribers.show?.();
    // Same height: a re-layout, not the lift — the committed viewport is
    // unchanged, so there is nothing new to anchor against.
    onViewportLayout(600);
    expect(scrollToIndex).not.toHaveBeenCalled();
    onViewportLayout(300);
    expect(scrollToIndex).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('drops the parked scroll when the user grabs the list (invalidate)', () => {
    const { markFocus, onViewportLayout, invalidate, scrollToIndex, unmount } = mountHook();
    onViewportLayout(600);
    markFocus(4);
    invalidate();
    keyboardSubscribers.show?.();
    onViewportLayout(300);
    expect(scrollToIndex).not.toHaveBeenCalled();
    unmount();
  });

  it('drops the parked scroll when the keyboard hides before the commit lands', () => {
    const { markFocus, onViewportLayout, scrollToIndex, unmount } = mountHook();
    onViewportLayout(600);
    markFocus(4);
    keyboardSubscribers.hide?.();
    keyboardSubscribers.show?.();
    onViewportLayout(300);
    expect(scrollToIndex).not.toHaveBeenCalled();
    unmount();
  });
});
