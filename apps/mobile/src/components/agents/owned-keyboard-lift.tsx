import { type ReactNode } from 'react';
import { View } from 'react-native';

type OwnedKeyboardLiftProps = {
  /** The keyboard band this screen's own input raised; 0 while it is closed. */
  occlusion: number;
  children: ReactNode;
};

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
 * Ownership still gates the pad, so a keyboard another screen raised pads
 * nothing here (see `useOwnedKeyboard`).
 */
export function OwnedKeyboardLift({ occlusion, children }: Readonly<OwnedKeyboardLiftProps>) {
  return (
    <View className="flex-1" style={{ paddingBottom: occlusion }}>
      {children}
    </View>
  );
}
