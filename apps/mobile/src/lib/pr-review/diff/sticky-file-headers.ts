import { type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';

/** Layout indices of every *expanded* `file-header` row for FlashList `stickyHeaderIndices`. */
export function stickyFileHeaderIndices(items: readonly ListItem[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    const item = items[i];
    if (item?.kind === 'file-header' && item.expanded) {
      indices.push(i);
    }
  }
  return indices;
}
