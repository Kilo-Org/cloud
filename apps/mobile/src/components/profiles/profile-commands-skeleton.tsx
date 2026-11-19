/**
 * The profile commands screen's skeleton. The screen file owns the list and
 * its save machinery; this part draws the loading blocks, so the screen stays
 * under the file-size bound.
 */

import { View } from 'react-native';

import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { RowGroup } from '@/components/ui/row-group';
import { Skeleton } from '@/components/ui/skeleton';
import { COMPACT_CONTROL_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Content-shaped blocks in the same slots and grouped surface as a loaded
 * command slot: the label line with its field box, then the action line the
 * item ends with.
 */
export function CommandsSkeleton() {
  return (
    <RowGroup>
      {[0, 1, 2].map(index => (
        <View key={index} className="gap-3 px-4 py-3">
          <View className="gap-1.5">
            <Skeleton className="h-4 w-20 rounded bg-muted-soft" />
            <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, 'w-full rounded-md bg-muted-soft')} />
          </View>
          <View className="flex-row items-center justify-end gap-5">
            {[0, 1, 2].map(control => (
              <Skeleton
                key={control}
                className={cn(COMPACT_CONTROL_BOX_CLASS, 'rounded-lg bg-muted-soft')}
              />
            ))}
          </View>
        </View>
      ))}
    </RowGroup>
  );
}
