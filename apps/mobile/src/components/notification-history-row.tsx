import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { RowChevron } from '@/components/ui/row-chevron';
import { Text } from '@/components/ui/text';
import { notificationHistoryCopy } from '@/lib/notification-history';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

type HistoryPage = inferRouterOutputs<MobileRouter>['user']['getNotificationHistory'];
export type HistoryRow = HistoryPage['items'][number];

/**
 * One recorded notification: the copy a push showed, and how long ago. A flat
 * list row, so it owns the page gutter and the hairline under itself.
 */
export function HistoryRowView({
  row,
  now,
  last,
  onOpen,
}: Readonly<{
  row: HistoryRow;
  now: number;
  /** The final row of the list draws no divider under it. */
  last: boolean;
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
        'gap-1 px-4 py-3 active:opacity-70',
        !last && 'border-b-[0.5px] border-hair-soft'
      )}
      accessibilityRole="button"
      onPress={() => {
        onOpen(row.payload);
      }}
    >
      <View className="flex-row items-baseline gap-3">
        <Text className="flex-1 text-sm font-medium" numberOfLines={headlineLines}>
          {copy.headline}
        </Text>
        <Text variant="caption">{timeAgo(parseTimestamp(row.createdAt), undefined, now)}</Text>
        <RowChevron />
      </View>
      {copy.detail === null ? null : (
        <Text variant="muted" numberOfLines={3}>
          {copy.detail}
        </Text>
      )}
    </Pressable>
  );
}
