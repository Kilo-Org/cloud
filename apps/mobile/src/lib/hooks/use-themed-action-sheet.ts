import { type ActionSheetOptions } from '@expo/react-native-action-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/**
 * Style fields `showActionSheetWithOptions` needs from every call so the
 * sheet follows the current theme. The library's Android sheet hardcodes a
 * light appearance — white group container, near-black option text, grey
 * title — so an unthemed call renders a light list in dark mode. iOS
 * delegates to native ActionSheetIOS, which ignores these style fields, so
 * spreading the same base options is safe there.
 *
 * Option text color rides on `textStyle.color` (the library falls back to it
 * when `tintColor` is unset); `tintColor` itself is left unset because iOS
 * honors it and would recolor native sheet buttons.
 */
export type ThemedActionSheetOptions = Pick<
  ActionSheetOptions,
  'containerStyle' | 'textStyle' | 'titleTextStyle' | 'messageTextStyle' | 'destructiveColor'
>;

/** Base options every `showActionSheetWithOptions` call spreads first. */
export function useThemedActionSheetOptions(): ThemedActionSheetOptions {
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  return {
    containerStyle: { backgroundColor: colors.card, paddingBottom: bottom },
    textStyle: { color: colors.foreground },
    titleTextStyle: { color: colors.mutedForeground },
    messageTextStyle: { color: colors.mutedForeground },
    destructiveColor: colors.destructive,
  };
}
