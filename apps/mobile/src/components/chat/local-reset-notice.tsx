import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { X } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

/**
 * Explains that the encrypted store could not be opened, so the local chats and
 * their drafts were deleted (see `lib/persist/encrypted-kv.ts`). Cloud sessions
 * live on the server and are untouched, which the body says so the loss does
 * not read as everything having been erased.
 *
 * It sits at the page gutter above the list body, for every body kind, so an
 * emptied list is never read as an ordinary empty state. It stays until the
 * person dismisses it: a loss this large must not disappear on a relaunch.
 *
 * The card arrives without a press, so a screen reader has to learn about it.
 * `AccessibleStatus` carries both channels: the polite live region where the
 * platform has one, and the imperative announcement where it does not. The card
 * is not itself `accessible`: that would shadow the dismiss control inside it.
 *
 * The dismiss control floats on the card's top end with its whole 48dp box, and
 * the title keeps a `pe-14` (49dp) clearance so no title ink can run under it.
 * A 48dp band inside the title row would be that row's tallest item and push the
 * body away from its title; an absolutely positioned child leaves the row at the
 * title's own line box. The control's box is its measured and delivered target,
 * inside an ancestor (the card) far taller than 48dp, so no slop has to reach
 * past a 32dp row and no negative margin shrinks the rect.
 */
export function LocalResetNoticeCard({ onDismiss }: { readonly onDismiss: () => void }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const body = t('modelChat.list.resetNoticeBody');

  return (
    <View
      accessibilityRole="alert"
      testID="chat-reset-notice"
      className="mx-4 mt-2 rounded-xl border border-warn-tile-border bg-warn-tile-bg p-4"
    >
      <View className="flex-row items-center pe-14">
        <Text className="min-w-0 flex-1 text-base font-medium text-warn">
          {t('modelChat.list.resetNoticeTitle')}
        </Text>
      </View>
      {/* The live region sits on the body `Text`, which is the node that
          changes: the announcement hook covers a platform without live
          regions, and a role on an ancestor View is not a live region. */}
      {/* 7dp from the title's line box, inside the 6-8dp the title needs to
          read as this body's heading: the design gate measures the text boxes,
          and `mt-1` (3.5dp) would leave the pair visibly apart. */}
      <AccessibleStatus message={body} tone="status" className="mt-2 text-base text-foreground" />
      <Pressable
        className={cn(ICON_TARGET_BOX_CLASS, 'absolute end-0 top-0 active:opacity-70')}
        accessibilityRole="button"
        accessibilityLabel={t('modelChat.list.resetNoticeDismiss')}
        onPress={onDismiss}
      >
        <X size={18} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
