// First-page placeholder for the PR Files tab. Rendered outside FlashList so
// the list mounts only once real file rows exist (cold first paint matches the
// warm-cache shape that paints immediately).

import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

const SKELETON_ROWS = [0, 1, 2, 3, 4, 5, 6, 7] as const;

export function PrDiffFileListLoading() {
  return (
    <View
      className="flex-1 gap-0 px-0 pt-1"
      accessibilityLabel="Loading files"
      accessibilityRole="progressbar"
    >
      {SKELETON_ROWS.map(index => (
        <View
          key={`file-list-skeleton-${index}`}
          className="flex-row items-center gap-3 border-b border-hair-soft px-4 py-3"
        >
          <Skeleton className="h-5 w-5 rounded-md" />
          <View className="flex-1 gap-1.5">
            <Skeleton className="h-3.5 w-3/4 rounded-md" />
            <Skeleton className="h-3 w-1/4 rounded-md" />
          </View>
          <Skeleton className="h-5 w-5 rounded-md" />
        </View>
      ))}
    </View>
  );
}
