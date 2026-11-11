import { type ReactNode, useCallback, useEffect, useState } from 'react';
import { type LayoutChangeEvent, View } from 'react-native';

import { MIN_BODY_VIEWPORT } from '@/lib/body-viewport';

export type OwnedKeyboardLiftProps = {
  /** The keyboard band this screen's own input raised; 0 while it is closed. */
  occlusion: number;
  /**
   * The pad this lift wrote, so a caller that reserves the same band elsewhere
   * (the Agents list's floating action button) tracks what is left of it.
   */
  onApplied?: (applied: number) => void;
  children: ReactNode;
};

/**
 * The pad the body frame takes for `occlusion`: the whole band while the frame
 * can afford it, and never more than the room that keeps `MIN_BODY_VIEWPORT`.
 *
 * `frameHeight` is the frame's own laid-out height, `null` before the first
 * measurement. A pad is inside that frame, so measuring it cannot feed back
 * into the value being clamped.
 */
export function clampLiftPad(occlusion: number, frameHeight: number | null): number {
  if (occlusion <= 0) {
    return 0;
  }
  if (frameHeight === null) {
    return occlusion;
  }
  return Math.min(occlusion, Math.max(0, frameHeight - MIN_BODY_VIEWPORT));
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
 * The pad is clamped so the body keeps a viewport. A keyboard height belongs to
 * the window geometry it was measured in, and a rotation replaces that geometry
 * with a much shorter one — an iPhone's landscape window is shorter than its own
 * portrait keyboard. An unclamped pad then fills the whole body and the list
 * renders nothing, with no rows, skeleton, empty state or error to explain it.
 * The clamp keeps `MIN_BODY_VIEWPORT` points of body until a fresh keyboard
 * height arrives (see `@/lib/body-viewport`).
 *
 * Ownership still gates the pad, so a keyboard another screen raised pads
 * nothing here (see `useOwnedKeyboard`).
 */
export function OwnedKeyboardLift({
  occlusion,
  onApplied,
  children,
}: Readonly<OwnedKeyboardLiftProps>) {
  const [frameHeight, setFrameHeight] = useState<number | null>(null);
  const pad = clampLiftPad(occlusion, frameHeight);
  const handleLayout = useCallback((event: LayoutChangeEvent) => {
    const { height } = event.nativeEvent.layout;
    setFrameHeight(previous => (previous === height ? previous : height));
  }, []);
  useEffect(() => {
    onApplied?.(pad);
  }, [onApplied, pad]);
  return (
    <View className="flex-1" style={{ paddingBottom: pad }} onLayout={handleLayout}>
      {children}
    </View>
  );
}
