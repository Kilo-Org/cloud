import { type ReactNode, useCallback, useState } from 'react';
import { type LayoutChangeEvent, useWindowDimensions, View } from 'react-native';

import { MIN_BODY_VIEWPORT } from '@/lib/body-viewport';

/**
 * The frame height the lift last measured, and the window it was measured in.
 *
 * The height alone cannot bound the pad: a rotation replaces the window with a
 * shorter one, and the frame's new height arrives from a layout pass that runs
 * after the first post-rotation render. A height measured in the previous
 * window therefore says nothing about the room this window leaves.
 */
export type LiftFrameMeasurement = {
  /** The body frame's laid-out height, in points. */
  height: number;
  /** The window height the frame was laid out in. */
  windowHeight: number;
};

/**
 * The pad the body frame takes for `occlusion`: the whole band while the frame
 * can afford it, and never more than the room that keeps `MIN_BODY_VIEWPORT`.
 *
 * `measured` is `null` before the first layout, and holds the window it belongs
 * to after it. A pad is inside that frame, so measuring it cannot feed back into
 * the value being clamped.
 *
 * Three cases, in order:
 *
 * - No keyboard band: nothing to reserve.
 * - No measurement yet: reserve the whole band. The frame has not been laid out
 *   in any window, so there is no room to compare against, and the band the
 *   keyboard just raised is the current window's own.
 * - A measurement from another window: release the band for this render. The
 *   height it carries belongs to a window this screen no longer has, and a band
 *   taller than the new frame fills the body — the list then draws nothing at
 *   all, with no rows, skeleton, empty state or error. The layout pass that
 *   follows reports the new height, and the next render clamps against it, so
 *   the body shows its rows for the frame between, with the lowest points under
 *   the keyboard until the pad returns.
 */
export function clampLiftPad(
  occlusion: number,
  measured: LiftFrameMeasurement | null,
  windowHeight: number
): number {
  if (occlusion <= 0) {
    return 0;
  }
  if (measured === null) {
    return occlusion;
  }
  if (measured.windowHeight !== windowHeight) {
    return 0;
  }
  return Math.min(occlusion, Math.max(0, measured.height - MIN_BODY_VIEWPORT));
}

type LayoutHandler = (event: LayoutChangeEvent) => void;

/** What a screen needs to reserve this keyboard band. */
export type KeyboardLiftFrame = {
  /** The pad the body frame takes for the band the screen's own input raised. */
  pad: number;
  /** The frame's layout reporter; pass it as the lift's `onLayout`. */
  handleLayout: LayoutHandler;
};

type OwnedKeyboardLiftProps = {
  pad: KeyboardLiftFrame['pad'];
  onLayout: LayoutHandler;
  children: ReactNode;
};

/**
 * The keyboard band a screen's body frame reserves, clamped so the body keeps a
 * viewport.
 *
 * The screen reads the pad itself, in the same render that writes it, so a
 * caller that reserves the same band elsewhere (the Agents list's floating
 * action button) cannot fall a commit behind the pad the body actually gave up.
 *
 * A keyboard height belongs to the window geometry it was measured in, and a
 * rotation replaces that geometry with a much shorter one — an iPhone's
 * landscape window is shorter than its own portrait keyboard. An unclamped pad
 * then fills the whole body and the list renders nothing, with no rows,
 * skeleton, empty state or error to explain it. The clamp keeps
 * `MIN_BODY_VIEWPORT` points of body, and drops a measurement taken in another
 * window rather than trusting it for the render the rotation produces (see
 * `@/lib/body-viewport` and `clampLiftPad`).
 */
export function useKeyboardLiftPad(occlusion: number): KeyboardLiftFrame {
  const { height: windowHeight } = useWindowDimensions();
  const [measured, setMeasured] = useState<LiftFrameMeasurement | null>(null);
  const handleLayout = useCallback(
    (event: LayoutChangeEvent) => {
      const { height } = event.nativeEvent.layout;
      setMeasured(previous =>
        previous?.height === height && previous.windowHeight === windowHeight
          ? previous
          : { height, windowHeight }
      );
    },
    [windowHeight]
  );
  return { pad: clampLiftPad(occlusion, measured, windowHeight), handleLayout };
}

/**
 * The body frame that clears this screen's own keyboard.
 *
 * A plain view writes `paddingBottom` on every render. The library's keyboard
 * container it replaces dropped its animated style when `enabled` turned false,
 * and the property that style last applied stayed on the native view: after the
 * search keyboard closed, the body kept its keyboard-height pad until the screen
 * remounted, so the list ended above the tab bar with a dead band below it.
 * Writing the pad always, 0 included, leaves no stale value to restore.
 *
 * Ownership still gates the band, so a keyboard another screen raised pads
 * nothing here (see `useOwnedKeyboard`), and `useKeyboardLiftPad` supplies the
 * clamp.
 */
export function OwnedKeyboardLift({ pad, onLayout, children }: Readonly<OwnedKeyboardLiftProps>) {
  return (
    <View className="flex-1" style={{ paddingBottom: pad }} onLayout={onLayout}>
      {children}
    </View>
  );
}
