import { View } from 'react-native';

import { RowSkeleton } from '@/components/ui/row-skeleton';

/**
 * Enough rows to fill the list's first frame: a flat finding row is shorter
 * than the card it replaced, so the placeholder keeps the screen covered until
 * the first page lands.
 */
const SKELETON_ROW_COUNT = 6;

/**
 * One finding row's placeholder. It is the shared `RowSkeleton` — a flat row's
 * own geometry, a title bar and the repository line under it — plus the
 * hairline every flat list row but the last carries, so the rows hand over to
 * the loaded list without moving.
 */
export function FindingRowSkeleton({ last = false }: Readonly<{ last?: boolean }>) {
  return (
    <View testID="finding-row-skeleton">
      <RowSkeleton subtitle className={last ? undefined : 'border-b-[0.5px] border-hair-soft'} />
    </View>
  );
}

/** The placeholder rows of a findings list, full-bleed like the loaded rows. */
export function FindingListSkeletonRows() {
  return (
    <View testID="finding-list-skeleton">
      {Array.from({ length: SKELETON_ROW_COUNT }, (_, index) => (
        <FindingRowSkeleton key={index} last={index === SKELETON_ROW_COUNT - 1} />
      ))}
    </View>
  );
}
