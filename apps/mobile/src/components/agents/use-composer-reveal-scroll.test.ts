// Unit coverage for the composer-card reveal on the New session screen: with
// the keyboard up the scroll body must park at the offset that puts the
// composer card's bottom row (the mode/model pills) at the viewport's bottom,
// against the COMMITTED viewport and card — never a guessed frame.
//
// Platforms commit the keyboard lift in opposite orders (Android: the padding
// view commits AFTER `keyboardDidShow`; iOS: BEFORE it), so the suite drives
// both orders through the viewport/composer layout channels. The keyboard-down
// state must stay the untouched baseline: no scroll until a show event arrives,
// and the hide gives the user's own offset back.
//
// The drag flag is session-scoped: a grab made while the keyboard was down must
// not suppress the next session's reveal, while a grab during the session wins
// for the rest of it.
// The hook is mounted by calling it as a plain function with stubbed React
// primitives (the same pattern as use-reply-focus-scroll.test.ts): one
// ref/effect/callback slot per hook slot, effects run immediately and collect
// their cleanups. The node environment has no rAF; a synchronous stub stands in
// (the hook defers nothing, so this is inert here).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resolveComposerRevealOffset, useComposerRevealScroll } from './use-composer-reveal-scroll';

const keyboardSubscribers = vi.hoisted(() => ({
  show: null as (() => void) | null,
  hide: null as (() => void) | null,
}));

// No Platform in the react-native mock: the hook has one implementation for
// both platforms (the did-events fire everywhere), so any platform fork would
// crash here instead of passing silently on the mocked OS.
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

// The React-primitive slots are generic over the hook's actual call order; the
// mock hands out slots on demand, so a hook refactor that reorders refs does not
// silently misalign.
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
  onViewportLayout: (height: number) => void;
  onComposerLayout: (layout: { y: number; height: number }) => void;
  onScroll: (offset: number) => void;
  onUserScroll: () => void;
  scrollTo: ReturnType<typeof vi.fn>;
  unmount: () => void;
};

function mountHook(): Mounted {
  slots.refs = [];
  slots.refCursor = 0;
  slots.cleanups = [];
  const scrollTo = vi.fn();
  // Property container, not a bare `let`: the hook's return is assigned inside
  // Harness, and control-flow narrowing of a bare variable would type it as the
  // initial `undefined` at the spread below.
  const produced: { current: ReturnType<typeof useComposerRevealScroll> | undefined } = {
    current: undefined,
  };
  function Harness(): null {
    produced.current = useComposerRevealScroll();
    return null;
  }
  // eslint-disable-next-line new-cap -- plain-function mount of the hook harness
  Harness();
  if (!produced.current) {
    throw new Error('hook produced no surface');
  }
  const scrollRef = produced.current.scrollRef as unknown as {
    current: { scrollTo: ReturnType<typeof vi.fn> } | null;
  };
  scrollRef.current = { scrollTo };
  return {
    ...produced.current,
    scrollTo,
    unmount: () => {
      for (const cleanup of slots.cleanups.splice(0)) {
        cleanup();
      }
    },
  };
}

describe('resolveComposerRevealOffset', () => {
  it('returns 0 when the card already fits', () => {
    expect(
      resolveComposerRevealOffset({ viewportHeight: 600, composerTop: 16, composerHeight: 420 })
    ).toBe(0);
  });

  it('returns the minimum offset that puts the card bottom at the viewport bottom', () => {
    expect(
      resolveComposerRevealOffset({ viewportHeight: 380, composerTop: 16, composerHeight: 420 })
    ).toBe(56);
  });

  it('rounds the offset up so the card keeps its last pixel', () => {
    expect(
      resolveComposerRevealOffset({
        viewportHeight: 380.5,
        composerTop: 16.2,
        composerHeight: 420.4,
      })
    ).toBe(57);
  });

  it('returns 0 for an uncommitted viewport or composer', () => {
    expect(
      resolveComposerRevealOffset({ viewportHeight: 0, composerTop: 16, composerHeight: 420 })
    ).toBe(0);
    expect(
      resolveComposerRevealOffset({ viewportHeight: 380, composerTop: 16, composerHeight: 0 })
    ).toBe(0);
  });
});

describe('useComposerRevealScroll', () => {
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

  it('arms the keyboard show and hide listeners and removes them on unmount', () => {
    const { unmount } = mountHook();
    expect(keyboardSubscribers.show).toBeTypeOf('function');
    expect(keyboardSubscribers.hide).toBeTypeOf('function');
    unmount();
    expect(keyboardSubscribers.show).toBeNull();
    expect(keyboardSubscribers.hide).toBeNull();
  });

  it('Android order: reveals on the post-show viewport commit', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    // The unlifted baseline the body reports at mount, and the card layout.
    onViewportLayout(800);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).not.toHaveBeenCalled();

    // Android commits the lift AFTER keyboardDidShow: the show event alone
    // computes against the pre-lift viewport, where the card still fits.
    keyboardSubscribers.show?.();
    expect(scrollTo).not.toHaveBeenCalled();

    onViewportLayout(380);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 56, animated: false });
    unmount();
  });

  it('iOS order: reveals on keyboardDidShow after the lift already committed', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    // iOS commits the lift (keyboardWillShow padding) while the keyboard is
    // still animating in: the commit alone must not scroll.
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).not.toHaveBeenCalled();

    keyboardSubscribers.show?.();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 56, animated: false });
    unmount();
  });

  it('does not scroll while the keyboard is hidden, even with a short viewport', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    onViewportLayout(360);
    expect(scrollTo).not.toHaveBeenCalled();
    unmount();
  });

  it('does not scroll while the card fits', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    keyboardSubscribers.show?.();
    onViewportLayout(800);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).not.toHaveBeenCalled();
    unmount();
  });

  it('re-reveals with the larger offset when the card grows while visible', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 56, animated: false });

    onComposerLayout({ y: 16, height: 520 });
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 156, animated: false });
    unmount();
  });

  it('restores the offset when the card shrinks back to fit, and clears the reveal', () => {
    const { onViewportLayout, onComposerLayout, onScroll, scrollTo, unmount } = mountHook();
    onScroll(120);
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 56, animated: false });

    // The user deleted lines / removed an attachment / a models error resolved:
    // the card fits again, so the stale reveal offset would leave its top
    // clipped under the header. The user's own offset comes back.
    onComposerLayout({ y: 16, height: 200 });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 120, animated: false });

    // The shrink-back already gave it back; the hide has nothing left to do.
    keyboardSubscribers.hide?.();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    unmount();
  });

  it('does not read a transient uncommitted measurement as a card that fits', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).toHaveBeenCalledTimes(1);

    onComposerLayout({ y: 0, height: 0 });
    onViewportLayout(0);
    expect(scrollTo).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('restores to the session start and reveals again when the card grows back', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    onComposerLayout({ y: 16, height: 200 });
    // No offset was captured before the reveal: the session start comes back.
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });

    onComposerLayout({ y: 16, height: 520 });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 156, animated: false });
    unmount();
  });

  it('a drag while the keyboard is down does not suppress the next reveal', () => {
    const { onViewportLayout, onComposerLayout, onUserScroll, scrollTo, unmount } = mountHook();
    // Keyboard DOWN: the composer auto-focus was dismissed and the user
    // scrolled the tall form. That grab belongs to the dead session and must
    // not poison the next one — tapping back into the prompt must reveal.
    onUserScroll();
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenCalledWith({ y: 56, animated: false });
    unmount();
  });

  it('gives the offset back when the keyboard hides', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).toHaveBeenCalledTimes(1);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 56, animated: false });

    // The keyboard-down view must be the untouched baseline: the form is far
    // taller than the lifted viewport, so the reveal offset has to come back.
    keyboardSubscribers.hide?.();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 0, animated: false });
    unmount();
  });

  it("gives the user's own offset back, not zero", () => {
    const { onViewportLayout, onComposerLayout, onScroll, scrollTo, unmount } = mountHook();
    // The user had already scrolled the form down before the reveal.
    onScroll(120);
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 56, animated: false });

    keyboardSubscribers.hide?.();
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 120, animated: false });
    unmount();
  });

  it('keeps the position when the user dragged during the session', () => {
    const { onViewportLayout, onComposerLayout, onUserScroll, scrollTo, unmount } = mountHook();
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // The user scrolled away from the reveal: their position is the one to
    // keep, so the hide must not scroll back.
    onUserScroll();
    keyboardSubscribers.hide?.();
    expect(scrollTo).toHaveBeenCalledTimes(1);
    unmount();
  });

  it('does not restore when nothing was revealed', () => {
    const { onViewportLayout, onComposerLayout, scrollTo, unmount } = mountHook();
    keyboardSubscribers.show?.();
    // The card already fits the lifted viewport: no reveal, so no restore.
    onViewportLayout(800);
    onComposerLayout({ y: 16, height: 420 });
    keyboardSubscribers.hide?.();
    expect(scrollTo).not.toHaveBeenCalled();
    unmount();
  });

  it('lets a user drag win until the next show', () => {
    const { onViewportLayout, onComposerLayout, onUserScroll, scrollTo, unmount } = mountHook();
    keyboardSubscribers.show?.();
    onViewportLayout(380);
    onComposerLayout({ y: 16, height: 420 });
    expect(scrollTo).toHaveBeenCalledTimes(1);

    onUserScroll();
    onComposerLayout({ y: 16, height: 520 });
    onViewportLayout(360);
    expect(scrollTo).toHaveBeenCalledTimes(1);

    // A hide ends the session; the next show reveals again.
    keyboardSubscribers.hide?.();
    keyboardSubscribers.show?.();
    expect(scrollTo).toHaveBeenCalledTimes(2);
    expect(scrollTo).toHaveBeenLastCalledWith({ y: 176, animated: false });
    unmount();
  });
});
