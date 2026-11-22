import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { AccessibleStatus } from '@/components/ui/accessible-status';
import { IconButton } from '@/components/ui/icon-button';
import { X } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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
 */
export function LocalResetNoticeCard({ onDismiss }: { readonly onDismiss: () => void }) {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const body = t('modelChat.list.resetNoticeBody');

  return (
    <View
      accessibilityRole="alert"
      testID="chat-reset-notice"
      className="mx-4 mt-2 gap-3 rounded-xl border border-warn-tile-border bg-warn-tile-bg p-4"
    >
      <View className="flex-row items-center gap-2">
        <Text className="min-w-0 flex-1 text-base font-medium text-warn">
          {t('modelChat.list.resetNoticeTitle')}
        </Text>
        {/* The box alone carries the target, so no negative margin may shrink
            it: the measured view rect would land under 44dp. */}
        <IconButton
          accessibilityLabel={t('modelChat.list.resetNoticeDismiss')}
          className="shrink-0"
          onPress={onDismiss}
        >
          <X size={18} color={colors.foreground} />
        </IconButton>
      </View>
      {/* The live region sits on the body `Text`, which is the node that
          changes: the announcement hook covers a platform without live
          regions, and a role on an ancestor View is not a live region. */}
      <AccessibleStatus message={body} tone="status" className="text-base text-foreground" />
    </View>
  );
}
