import { View } from 'react-native';

import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_ROW_COUNT = 8;

/**
 * One flat-list row placeholder: the shared session skeleton, which owns the
 * flat row's strip, eyebrow, title and divider geometry, so the loaded rows
 * land exactly where the placeholders stood.
 */
export function SessionRowSkeleton({
  subtitle,
  last = false,
}: Readonly<{ subtitle: boolean; last?: boolean }>) {
  return (
    <View testID="session-row-skeleton">
      <RowSkeleton variant="session" subtitle={subtitle} last={last} />
    </View>
  );
}

/**
 * The history list's date-header placeholder, in `SessionListSectionHeader`'s
 * geometry, so the first stored rows land where the placeholders stood.
 */
export function SessionSectionHeaderSkeleton() {
  return (
    <View className="px-4 py-2">
      <View className="h-4 flex-row items-center justify-between">
        <Skeleton className="h-2 w-12 rounded-full" />
        <Skeleton className="h-2 w-2 rounded-full" />
      </View>
    </View>
  );
}

/**
 * The live list's placeholder rows while the first load is pending. The screen
 * reserves the refresh-status band above both placeholders and loaded rows.
 */
export function SessionListSkeletonRows({
  insets,
}: Readonly<{ insets: { left: number; right: number } }>) {
  return (
    <View style={{ paddingLeft: insets.left, paddingRight: insets.right }}>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
        <SessionRowSkeleton key={i} subtitle last={i === SKELETON_ROW_COUNT - 1} />
      ))}
    </View>
  );
}
