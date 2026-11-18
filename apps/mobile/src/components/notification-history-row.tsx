import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { notificationHistoryCopy } from '@/lib/notification-history';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

type HistoryPage = inferRouterOutputs<MobileRouter>['user']['getNotificationHistory'];
export type HistoryRow = HistoryPage['items'][number];

/** One recorded notification: the copy a push showed, and how long ago. */
export function HistoryRowView({
  row,
  now,
  onOpen,
}: Readonly<{
  row: HistoryRow;
  now: number;
  onOpen: (payload: Record<string, unknown>) => void;
}>) {
  const { i18n } = useTranslation();
  const copy = notificationHistoryCopy(row, i18n.language);
  // A headline that is the whole row takes the body's three lines; one with a
  // message under it keeps the title's two.
  const headlineLines = copy.detail === null ? 3 : 2;
  return (
    <Pressable
      className={cn(
        ROW_TARGET_CLASS,
        'mb-3 justify-center rounded-2xl border border-border bg-card px-4 py-3 active:opacity-70'
      )}
      accessibilityRole="button"
      onPress={() => {
        onOpen(row.payload);
      }}
    >
      <View className="flex-row items-start gap-3">
        <Text className="flex-1 text-sm font-medium" numberOfLines={headlineLines}>
          {copy.headline}
        </Text>
        {/* The title's `text-sm` line box is 1.25rem tall; the time takes the
            same height, so both first lines share one centre while a two-line
            title keeps its own lines. */}
        <Text variant="muted" className="text-xs leading-[1.25rem]">
          {timeAgo(parseTimestamp(row.createdAt), undefined, now)}
        </Text>
      </View>
      {copy.detail === null ? null : (
        <Text variant="muted" className="mt-1 text-sm" numberOfLines={3}>
          {copy.detail}
        </Text>
      )}
    </Pressable>
  );
}
