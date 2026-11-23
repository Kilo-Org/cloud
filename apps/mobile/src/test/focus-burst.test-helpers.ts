import { act, type ReactTestInstance } from '@/test/renderer';

/**
 * The router focus effects a suite captured through its `expo-router` mock,
 * with the clock its `Date.now` spy reads.
 *
 * A screen's tap guard arms itself when the screen is focused again after a
 * pushed child closed itself, so a mounted case replays two focuses: the one a
 * fresh screen receives on mount, and the one a return produces.
 */
export type FocusEffects = {
  readonly effects: (() => void)[];
  now: number;
};

/** Run every focus effect the router registered so far. */
export async function runFocusEffects(focus: FocusEffects): Promise<void> {
  await act(async () => {
    for (const effect of focus.effects) {
      effect();
    }
    await Promise.resolve();
  });
}

/**
 * The press of the mounted row titled `title`, so a case writes the burst once
 * and the harness owns the lookup.
 */
export function pressRowOfTitle(root: ReactTestInstance, type: string, title: string): () => void {
  const row = root
    .findAll(node => String(node.type) === type)
    .find(node => node.props.title === title);
  if (!row) {
    throw new Error(`${type} titled ${title} not found`);
  }
  return () => {
    (row.props.onPress as () => void)();
  };
}

/** The steps of one "a press burst acts once" case, in the order a suite reads them. */
export type PressBurst = Readonly<{
  /** The focus a freshly mounted screen receives; it must not deaden a press. */
  mount: () => Promise<void>;
  /** The focus that follows a pushed child closing itself. */
  childClosed: () => Promise<void>;
  /** One deliberate press. */
  press: () => void;
  /** Two presses inside one burst, the shape a double tap produces. */
  burst: () => void;
  /** Move the clock past the guard window, then press once. */
  afterWindow: () => void;
}>;

/**
 * Replay a tap burst against a mounted screen. `press` performs the control's
 * real press, so the assertions stay in the suite and the harness only owns the
 * focus and clock steps.
 */
export function pressBurst(focus: FocusEffects, press: () => void): PressBurst {
  const pressOnce = (): void => {
    act(() => {
      press();
    });
  };
  return {
    mount: () => runFocusEffects(focus),
    childClosed: () => runFocusEffects(focus),
    press: pressOnce,
    burst: () => {
      pressOnce();
      pressOnce();
    },
    afterWindow: () => {
      focus.now += 1000;
      pressOnce();
    },
  };
}
