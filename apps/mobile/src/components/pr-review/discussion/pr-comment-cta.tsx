// Bottom call-to-action bar for the PR review Discussion tab.
//
// Static chrome: no async content renders here, so there is no skeleton and
// no layout shift when the list content changes above it. The bar is a column
// sibling under the tab body (see pr-review-discussion-tab.tsx): the body
// keeps flex-1, the bar keeps its natural height.
//
// Keyboard: KeyboardAvoidingView lifts the bar above the keyboard while it is
// open; while it is closed the lift is 0 and useDetailScreenBottomPadding
// (applied to the inner view) clears the device safe area. The two are separate
// because the lift view owns its own padding slot.

import { MessageSquarePlus } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import { KeyboardAvoidingView } from 'react-native-keyboard-controller';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { keyboardInsetOffset } from '@/lib/keyboard-inset-offset';
import { useDetailScreenBottomPadding } from '@/lib/screen-insets';

type PrCommentCtaProps = Readonly<{
  onPress: () => void;
  /**
   * Whether the bar may lift above an open keyboard. Only while the
   * Discussion tab is actually focused: the keyboard events are global, and
   * a lift driven by a keyboard the user opened on ANOTHER surface (the
   * conversation-comment formSheet) shrinks the list viewport behind the
   * sheet and parks the last thread's reply field under the bar (uxs3 spot
   * check, e4-confirm-discard). The host passes the screen's focus state.
   */
  keyboardLift: boolean;
}>;

export function PrCommentCta({ onPress, keyboardLift }: PrCommentCtaProps) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const bottomPadding = useDetailScreenBottomPadding();
  const { bottom } = useSafeAreaInsets();
  const bar = (
    <View className="px-4 pt-3" style={{ paddingBottom: bottomPadding }}>
      <Button
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={t('prReview.discussion.addCommentCta')}
      >
        <MessageSquarePlus size={14} color={colors.primaryForeground} />
        <Text>{t('prReview.discussion.addCommentCta')}</Text>
      </Button>
    </View>
  );
  // Unmounted (not just un-padded) while unfocused: the lift must not react to
  // another surface's keyboard at all. The bar's inner padding already includes
  // the platform's bottom inset (`useDetailScreenBottomPadding`), so the lift is
  // reduced by that inset and the button never floats a navigation-bar height
  // above the keyboard.
  return keyboardLift ? (
    <KeyboardAvoidingView behavior="padding" keyboardVerticalOffset={keyboardInsetOffset(bottom)}>
      {bar}
    </KeyboardAvoidingView>
  ) : (
    bar
  );
}
