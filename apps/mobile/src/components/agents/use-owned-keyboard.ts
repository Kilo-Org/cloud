import { useFocusEffect } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useKeyboardState } from 'react-native-keyboard-controller';

/**
 * The keyboard this screen's own input raised.
 *
 * A pushed screen's keyboard is still closing when this screen regains focus.
 * Reading that keyboard padded the body for the length of the close, so the
 * centered content moved down after the back transition. The screen claims the
 * keyboard only while its own input holds focus, so a keyboard another screen
 * raised is never read, and a hide and re-show that keeps the input focused
 * (Android Back, then a tap on the field) stays claimed. Leaving the screen also
 * releases the claim, because the input can keep focus without emitting blur;
 * iOS emits focus again when it restores the field on return.
 *
 * The claim is a latch, not a live focus read, and the difference is what keeps
 * the lift off a closed keyboard. An empty animated style is not an update:
 * `useAnimatedStyle` emits nothing for it, so the last padding the native
 * container applied stays on the view. Disabling the container while the
 * keyboard is still on screen therefore freezes the keyboard-open padding: the
 * hide animation's zero is computed by a disabled container and discarded, and
 * nothing later writes another one. That is the blank band the history list
 * kept after its search keyboard closed. So the latch arms on focus and
 * releases only once the provider reports the keyboard hidden and the input no
 * longer holds focus: every hide is emitted while the container is enabled, and
 * the container is never disabled with padding still applied.
 *
 * A focus that arrives while a keyboard is already on screen does not arm the
 * latch. The input cannot have raised that keyboard — it was up before the
 * input took focus — so it belongs to the screen the user came from, and arming
 * there would pad this screen for the foreign close.
 */
export function useOwnedKeyboard() {
  const { isVisible, height } = useKeyboardState();
  const [focused, setFocused] = useState(false);
  const [armed, setArmed] = useState(false);
  // Read by the stable focus callback: it must see the keyboard state at the
  // moment of the focus event, not the one captured when the screen mounted.
  const visibleRef = useRef(isVisible);
  visibleRef.current = isVisible;
  const handleInputFocus = useCallback(() => {
    setFocused(true);
    setArmed(previous => previous || !visibleRef.current);
  }, []);
  const handleInputBlur = useCallback(() => {
    setFocused(false);
  }, []);
  // Releases the latch only after the keyboard is confirmed hidden, that is
  // after the container emitted its zero padding.
  useEffect(() => {
    if (!armed || focused || isVisible) {
      return;
    }
    setArmed(false);
  }, [armed, focused, isVisible]);
  useFocusEffect(useCallback(() => handleInputBlur, [handleInputBlur]));
  return {
    /** Whether the keyboard container may lift for this screen's input. */
    liftEnabled: armed,
    occlusion: armed && isVisible ? height : 0,
    handleInputFocus,
    handleInputBlur,
  };
}
