// Bottom call-to-action bar for the PR review Discussion tab.
//
// Static chrome: no async content renders here, so there is no skeleton and
// no layout shift when the list content changes above it. The bar is a column
// sibling under the tab body (see pr-review-discussion-tab.tsx): the body
// keeps flex-1, the bar keeps its natural height.
//
// Keyboard: AppAwareKeyboardPaddingView lifts the bar above the keyboard
// while it is open; while it is closed that padding is 0 and
// useDetailScreenBottomPadding (applied to the inner view) clears the device
// safe area. The two paddings are separate because the keyboard-padding view
// owns its own paddingBottom style slot, and the safe-area padding yields to
// the lift while the keyboard is open (it would otherwise show as an inset-tall
// blank band above the keyboard).

import { MessageSquarePlus } from '@/components/ui/icons';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import {
  AppAwareKeyboardPaddingView,
  useAppAwareKeyboardPadding,
} from '@/components/kilo-chat/app-aware-keyboard-padding';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
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
  const detailBottomPadding = useDetailScreenBottomPadding();
  // Unmounted (not just un-padded) while unfocused: the padding view's own
  // keyboard listener must not react to another surface's keyboard at all.
  return keyboardLift ? (
    <AppAwareKeyboardPaddingView>
      <KeyboardLiftedCommentBar onPress={onPress} detailBottomPadding={detailBottomPadding} />
    </AppAwareKeyboardPaddingView>
  ) : (
    <CommentBar onPress={onPress} bottomPadding={detailBottomPadding} />
  );
}

/**
 * Bar inside the keyboard-lift view. The lift already covers the strip the IME
 * hides — the device safe area included — so the padding that clears the safe
 * area while the keyboard is closed has to yield to it; keeping both shows the
 * inset as a blank band above the keyboard (the same rule the manual-review
 * footer follows).
 */
function KeyboardLiftedCommentBar({
  onPress,
  detailBottomPadding,
}: Readonly<{ onPress: () => void; detailBottomPadding: number }>) {
  const keyboardLift = useAppAwareKeyboardPadding();
  return (
    <CommentBar onPress={onPress} bottomPadding={Math.max(0, detailBottomPadding - keyboardLift)} />
  );
}

function CommentBar({
  onPress,
  bottomPadding,
}: Readonly<{ onPress: () => void; bottomPadding: number }>) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  return (
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
}
