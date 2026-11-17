/**
 * The profile commands screen's skeleton. The screen file owns the list and
 * its save machinery; this part draws the loading blocks, so the screen stays
 * under the file-size bound.
 */

import { View } from 'react-native';

import { Card } from '@/components/ui/card';
import { INPUT_BOX_SHAPE_CLASS } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { ICON_TARGET_BOX_CLASS } from '@/lib/a11y/tap-target';
import { cn } from '@/lib/utils';

/**
 * Content-shaped blocks in the same slots and card surface as a loaded command
 * slot: the label line with its row of 48pt controls, and the field's own 44pt
 * box.
 */
export function CommandsSkeleton() {
  return (
    <View className="gap-3">
      {[0, 1, 2].map(index => (
        <Card key={index}>
          <View className="flex-row items-center justify-between gap-3">
            <Skeleton className="h-4 w-20 rounded bg-muted-soft" />
            <Skeleton className={cn(ICON_TARGET_BOX_CLASS, 'rounded-lg bg-muted-soft')} />
          </View>
          <Skeleton className={cn(INPUT_BOX_SHAPE_CLASS, 'w-full rounded-md bg-muted-soft')} />
        </Card>
      ))}
    </View>
  );
}
