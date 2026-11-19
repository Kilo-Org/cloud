import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { SectionHeaderSkeleton } from '@/components/ui/section-header-skeleton';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';

/** The field's own 44pt box, so the loaded field replaces it without moving the card. */
const FIELD_BAR_CLASS = 'w-full rounded-md bg-muted-soft';

/**
 * Content-shaped loading blocks in the same slots as the loaded screen (the
 * metadata card, the default row, the repo-pins section, the settings rows and
 * the delete action) so the swap to real content does not move anything. The
 * rows and section labels are the primitives' own skeletons; the blocks use the
 * card and row group surfaces the loaded screen uses, and every field slot
 * reserves the input's own 44pt box.
 */
export function ProfileOverviewSkeleton() {
  return (
    <View className="gap-6">
      <Card>
        <View className="gap-1.5">
          <Skeleton className="h-4 w-24 rounded bg-muted-soft" />
          <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, FIELD_BAR_CLASS)} />
        </View>
        <View className="gap-1.5">
          <Skeleton className="h-4 w-32 rounded bg-muted-soft" />
          <Skeleton className="h-20 w-full rounded-md bg-muted-soft" />
        </View>
        <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, FIELD_BAR_CLASS)} />
      </Card>
      <RowGroup>
        <RowSkeleton tile subtitle trailing="switch" />
      </RowGroup>
      <View className="gap-3">
        <SectionHeaderSkeleton />
        <Skeleton className="h-3 w-56 rounded bg-muted-soft" />
        <RowGroup>
          <RowSkeleton subtitle trailingControl />
        </RowGroup>
      </View>
      <View className="gap-3">
        <SectionHeaderSkeleton />
        <RowGroup>
          {[0, 1, 2, 3, 4, 5].map(index => (
            <RowSkeleton key={index} tile subtitle />
          ))}
        </RowGroup>
      </View>
      <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, FIELD_BAR_CLASS)} />
    </View>
  );
}
