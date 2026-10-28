import { useCallback, useEffect, useState } from 'react';
import { useKeyboardState } from 'react-native-keyboard-controller';

/**
 * The keyboard this screen's own input raised.
 *
 * A pushed screen's keyboard is still closing when this screen regains focus.
 * Reading that keyboard padded the body for the length of the close, so the
 * centered content moved down after the back transition. The screen's input
 * claims the keyboard when it gains focus, and the claim ends once the
 * keyboard has hidden, so a keyboard another screen raised is never read.
 */
export function useOwnedKeyboard() {
  const { isVisible, height } = useKeyboardState();
  const [owned, setOwned] = useState(false);
  useEffect(() => {
    if (!isVisible) {
      setOwned(false);
    }
  }, [isVisible]);
  const handleInputFocus = useCallback(() => {
    setOwned(true);
  }, []);
  return { owned, occlusion: owned && isVisible ? height : 0, handleInputFocus };
}
