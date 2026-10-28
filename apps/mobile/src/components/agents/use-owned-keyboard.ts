import { useCallback, useState } from 'react';
import { useKeyboardState } from 'react-native-keyboard-controller';

/**
 * The keyboard this screen's own input raised.
 *
 * A pushed screen's keyboard is still closing when this screen regains focus.
 * Reading that keyboard padded the body for the length of the close, so the
 * centered content moved down after the back transition. The screen owns the
 * keyboard only while its own input holds focus, so a keyboard another screen
 * raised is never read, and a hide and re-show that keeps the input focused
 * (Android Back, then a tap on the field) stays owned.
 */
export function useOwnedKeyboard() {
  const { isVisible, height } = useKeyboardState();
  const [owned, setOwned] = useState(false);
  const handleInputFocus = useCallback(() => {
    setOwned(true);
  }, []);
  const handleInputBlur = useCallback(() => {
    setOwned(false);
  }, []);
  return {
    owned,
    occlusion: owned && isVisible ? height : 0,
    handleInputFocus,
    handleInputBlur,
  };
}
