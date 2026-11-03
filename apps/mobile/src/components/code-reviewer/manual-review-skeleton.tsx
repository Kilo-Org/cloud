import { View } from 'react-native';

import { Skeleton } from '@/components/ui/skeleton';

/**
 * Loading placeholder for the manual review body while the provider status is
 * still settling: the icon bubble, the title line and the full-width action of
 * the connect state it may resolve to, so the page never shows nothing under
 * its header and the state that arrives keeps the same shape.
 *
 * It centers itself instead of going through `CenteredState`, because that
 * component hides its content until the surface has been measured (up to
 * `STATE_SURFACE_FALLBACK_MS`) to keep a data state from flashing at the wrong
 * spot. A placeholder has the opposite requirement: it is the only thing on
 * screen while the status is unknown, so it is drawn from the first frame.
 */
export function ManualReviewSkeleton() {
  return (
    <View className="flex-1 items-center justify-center gap-4 px-6">
      <Skeleton className="h-14 w-14 rounded-2xl" />
      <Skeleton className="h-6 w-44 rounded" />
      <Skeleton className="mt-3 h-12 w-full rounded-md" />
    </View>
  );
}
