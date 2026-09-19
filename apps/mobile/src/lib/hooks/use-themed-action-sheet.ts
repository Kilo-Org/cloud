import { type ActionSheetOptions } from '@expo/react-native-action-sheet';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { useThemeColors } from '@/lib/hooks/use-theme-colors';

/** Shared custom-renderer options for iOS and Android; call sites may override them. */
export type ThemedActionSheetOptions = Pick<
  ActionSheetOptions,
  | 'containerStyle'
  | 'textStyle'
  | 'titleTextStyle'
  | 'messageTextStyle'
  | 'destructiveColor'
  | 'autoFocus'
  | 'useModal'
>;

/** Base options every `showActionSheetWithOptions` call spreads first. */
export function useThemedActionSheetOptions(): ThemedActionSheetOptions {
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  return {
    // Preserve native-sheet focus and visibility above modal screens on both platforms.
    autoFocus: true,
    useModal: true,
    containerStyle: { backgroundColor: colors.card, paddingBottom: bottom },
    textStyle: { color: colors.foreground },
    titleTextStyle: { color: colors.mutedForeground },
    messageTextStyle: { color: colors.mutedForeground },
    destructiveColor: colors.destructive,
  };
}
