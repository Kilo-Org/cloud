import { type ListItem } from '@/lib/pr-review/diff/pr-diff-list-items';

/** Layout indices of every `file-header` row for FlashList `stickyHeaderIndices`. */
export function stickyFileHeaderIndices(items: readonly ListItem[]): number[] {
  const indices: number[] = [];
  for (let i = 0; i < items.length; i += 1) {
    if (items[i]?.kind === 'file-header') {
      indices.push(i);
    }
  }
  return indices;
}
