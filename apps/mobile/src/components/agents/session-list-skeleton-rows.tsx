import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_ROW_COUNT = 8;

/** Title and subtitle bar widths, varied per row so the list does not read as a grid. */
const TITLE_WIDTHS = ['w-3/4', 'w-1/2', 'w-2/3', 'w-3/5'] as const;
const SUBTITLE_WIDTHS = ['w-2/5', 'w-1/3', 'w-1/2', 'w-1/4'] as const;

/**
 * One placeholder in the shape of an inline-strip `SessionRow`: hue strip,
 * eyebrow, title and optional subtitle, on the screen background with the
 * row's hairline divider. Each line sits in a slot of the real line's height,
 * so the placeholder has the pitch of a one-line-title row and the rows land
 * where the placeholders stood.
 */
export function SessionRowSkeleton({
  index,
  subtitle,
}: Readonly<{ index: number; subtitle: boolean }>) {
  const variant = index % TITLE_WIDTHS.length;
  return (
    <View
      testID="session-row-skeleton"
      className="flex-row gap-3 border-b-[0.5px] border-hair-soft px-[22px] py-[13px]"
    >
      <Skeleton className="w-[3px] rounded-[2px]" />
      <View className="flex-1">
        <View className="mb-[3px] h-[14px] justify-center">
          <Skeleton className="h-2 w-20 rounded-full" />
        </View>
        <View className="h-5 justify-center">
          <Skeleton className={`h-3 rounded-full ${TITLE_WIDTHS[variant]}`} />
        </View>
        {subtitle ? (
          <View className="mt-1 h-4 justify-center">
            <Skeleton className={`h-2 rounded-full ${SUBTITLE_WIDTHS[variant]}`} />
          </View>
        ) : null}
      </View>
    </View>
  );
}

/** The live list's placeholder rows while the first load is pending. */
export function SessionListSkeletonRows({
  sidePadding,
}: Readonly<{ sidePadding: { paddingLeft: number; paddingRight: number } }>) {
  return (
    <View className="pt-[18px]" style={sidePadding}>
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
        <SessionRowSkeleton key={i} index={i} subtitle />
      ))}
    </View>
  );
}
