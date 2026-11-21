import { useTranslation } from 'react-i18next';
import { Pressable, View } from 'react-native';

import { type CodeReviewStatus, isCodeReviewStatus } from '@kilocode/app-shared/code-review';
import { QueryError } from '@/components/query-error';
import { RowChevron } from '@/components/ui/row-chevron';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { type ReviewListItem } from '@/lib/hooks/use-code-reviews';
import { cn, parseTimestamp, timeAgo } from '@/lib/utils';

// Tone classes stay mobile-local; the label is the translated catalog key
// for the same stable status code web reads, so it can't drift from web.
const STATUS_CLASSNAME = {
  pending: 'text-muted-foreground',
  queued: 'text-muted-foreground',
  running: 'text-info',
  completed: 'text-good',
  failed: 'text-destructive',
  cancelled: 'text-muted-foreground',
  interrupted: 'text-warn',
} satisfies Record<CodeReviewStatus, string>;

const STATUS_KEY = {
  pending: 'common.pending',
  queued: 'common.queued',
  running: 'common.running',
  completed: 'common.completed',
  failed: 'common.failed',
  cancelled: 'common.cancelled',
  interrupted: 'codeReviewer.status.interrupted',
} satisfies Record<CodeReviewStatus, string>;

export function statusMeta(status: string) {
  if (!isCodeReviewStatus(status)) {
    return { label: status, className: 'text-muted-foreground' };
  }
  return {
    label: i18n.t(STATUS_KEY[status]),
    className: STATUS_CLASSNAME[status],
  };
}

/**
 * One recent review. Split from the screen so the list screen keeps the read
 * surface rather than the row layout.
 *
 * The row is the flat list row of the layout contract: full-bleed, its content
 * from the page gutter, a hairline between rows, and the trailing chevron that
 * says the press opens a detail.
 */
export function ReviewRow({
  review,
  last,
  now,
  onOpen,
}: Readonly<{
  review: ReviewListItem;
  last: boolean;
  now: number;
  onOpen: (review: ReviewListItem) => void;
}>) {
  const meta = statusMeta(review.status);
  return (
    <Pressable
      accessibilityRole="button"
      className={cn(
        'flex-row items-center gap-3 px-4 py-3 active:opacity-70',
        !last && 'border-b-[0.5px] border-hair-soft'
      )}
      onPress={() => {
        onOpen(review);
      }}
    >
      <View className="min-w-0 flex-1">
        <Text className="text-sm font-medium" numberOfLines={1}>
          {review.pr_title}
        </Text>
        <Text variant="muted" className="mt-0.5 text-xs">
          {review.repo_full_name} #{review.pr_number}
        </Text>
        <View className="mt-1 flex-row items-center gap-2">
          <Text className={cn('text-xs', meta.className)}>{meta.label}</Text>
          <Text variant="muted" className="text-xs">
            {timeAgo(
              parseTimestamp(review.completed_at ?? review.started_at ?? review.created_at),
              undefined,
              now
            )}
          </Text>
        </View>
      </View>
      <RowChevron />
    </Pressable>
  );
}

export function ReviewListFooter({
  loading,
  error,
  onRetry,
}: Readonly<{ loading: boolean; error: boolean; onRetry: () => void }>) {
  const { t } = useTranslation();
  if (loading) {
    // The next page lands as another row of the list, so its pending body holds
    // one row's three-line frame instead of a shorter grouped row.
    return <RowSkeleton lines={3} last />;
  }
  if (error) {
    return (
      <QueryError
        placement="top"
        inset="gutter"
        message={t('codeReviewer.reviewList.couldNotLoad')}
        onRetry={onRetry}
      />
    );
  }
  return null;
}
