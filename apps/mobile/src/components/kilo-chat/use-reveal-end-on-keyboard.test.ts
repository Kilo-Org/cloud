// Unit coverage for the keyboard reveal: a form whose call-to-action is its
// last child must scroll that action above an open keyboard, and must not
// scroll at all while the keyboard is closed. The retry re-runs the scroll one
// frame later, for the commit where the keyboard padding has not reached the
// scroll view yet.
//
// Mounted by calling the hook as a plain function with stubbed React
// primitives (the pattern of use-reply-focus-scroll.test.ts): one ref/effect
// slot per hook slot, effects run immediately and collect their cleanups.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { KEYBOARD_REVEAL_RETRY_MS, useRevealEndOnKeyboard } from './use-reveal-end-on-keyboard';

const keyboard = vi.hoisted(() => ({ padding: 0 }));

vi.mock('./app-aware-keyboard-padding', () => ({
  useAppAwareKeyboardPadding: () => keyboard.padding,
}));

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
}));

type Mounted = {
  scrollToEnd: ReturnType<typeof vi.fn>;
  unmount: () => void;
};

function mountHook(): Mounted {
  const scrollToEnd = vi.fn();
  slots.refs = [{ current: { scrollToEnd } }];
  slots.refCursor = 0;
  slots.cleanups = [];
  function Harness(): null {
    useRevealEndOnKeyboard();
    return null;
  }
  // eslint-disable-next-line new-cap -- plain-function mount of the hook harness
  Harness();
  return {
    scrollToEnd,
    unmount: () => {
      for (const cleanup of slots.cleanups.splice(0)) {
        cleanup();
      }
    },
  };
}

describe('useRevealEndOnKeyboard', () => {
  beforeEach(() => {
    keyboard.padding = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not scroll while the keyboard is closed', () => {
    const { scrollToEnd } = mountHook();

    vi.advanceTimersByTime(KEYBOARD_REVEAL_RETRY_MS * 4);

    expect(scrollToEnd).not.toHaveBeenCalled();
  });

  it('scrolls the call-to-action into view while the keyboard is open', () => {
    keyboard.padding = 300;

    const { scrollToEnd } = mountHook();
    expect(scrollToEnd).toHaveBeenCalledTimes(1);
    expect(scrollToEnd).toHaveBeenLastCalledWith({ animated: false });

    vi.advanceTimersByTime(KEYBOARD_REVEAL_RETRY_MS);
    expect(scrollToEnd).toHaveBeenCalledTimes(2);
  });

  it('drops the pending retry when the screen unmounts', () => {
    keyboard.padding = 300;

    const { scrollToEnd, unmount } = mountHook();
    unmount();
    vi.advanceTimersByTime(KEYBOARD_REVEAL_RETRY_MS * 4);

    expect(scrollToEnd).toHaveBeenCalledTimes(1);
  });
});
