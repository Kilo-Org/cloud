import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_ROW_COUNT = 8;

/** Title and subtitle bar widths, varied per row so the list does not read as a grid. */
const TITLE_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-3/5'] as const;
const SUBTITLE_WIDTHS = ['w-2/5', 'w-1/3', 'w-1/2', 'w-1/4'] as const;

/** Shared row geometry; history keeps its eyebrow-first layout. */
export function SessionRowSkeleton({
  index,
  subtitle,
  titleFirst = false,
}: Readonly<{ index: number; subtitle: boolean; titleFirst?: boolean }>) {
  const variant = index % TITLE_WIDTHS.length;
  return (
    <View
      testID="session-row-skeleton"
      className="flex-row gap-3 border-b-[0.5px] border-hair-soft px-[22px] py-[13px]"
    >
      {!titleFirst ? <Skeleton className="w-[3px] rounded-[2px]" /> : null}
      <View className="flex-1">
        {!titleFirst ? (
          <View className="mb-[3px] h-[14px] justify-center">
            <Skeleton className="h-2 w-20 rounded-full" />
          </View>
        ) : null}
        <View className={titleFirst ? 'h-[22px] justify-center' : 'h-5 justify-center'}>
          <Skeleton className={`h-3 rounded-full ${TITLE_WIDTHS[variant]}`} />
        </View>
        {subtitle ? (
          <View className="mt-1 h-4 justify-center">
            <Skeleton className={`h-2 rounded-full ${SUBTITLE_WIDTHS[variant]}`} />
          </View>
        ) : null}
        {titleFirst ? (
          <View className="mt-2 h-4 justify-center">
            <Skeleton className="h-2 w-1/3 rounded-full" />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The history list's date-header placeholder, in `SessionListSectionHeader`'s
 * geometry, so the first stored rows land where the placeholders stood.
 */
export function SessionSectionHeaderSkeleton() {
  return (
    <View className="px-[22px] pb-2 pt-[18px]">
      <View className="h-[14px] flex-row items-center justify-between">
        <Skeleton className="h-2 w-12 rounded-full" />
        <Skeleton className="h-2 w-2 rounded-full" />
      </View>
    </View>
  );
}

/**
 * The live list's placeholder rows while the first load is pending. The top
 * padding stands in for the refresh-status line (`gap-2` + `min-h-5`) that
 * `LiveSessionFeedback` reserves above loaded rows, and the side padding is the
 * same landscape inset the loaded list's content carries.
 */
export function SessionListSkeletonRows({
  insets,
}: Readonly<{ insets: { left: number; right: number } }>) {
  return (
    <View className="pt-7" style={{ paddingLeft: insets.left, paddingRight: insets.right }}>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
        <SessionRowSkeleton key={i} index={i} subtitle titleFirst />
      ))}
    </View>
  );
}
