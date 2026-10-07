import { batchCount } from './kwf-smoke-batches';

/**
 * The 1-based page numbers for `total` items with `size` items per page.
 *
 * Zero items still give `[1]` on purpose: the list API always reads page 1,
 * and an empty page 1 is its "no items" answer.
 */
export function pageNumbers(total: number, size: number): number[] {
  const last = Math.max(1, batchCount(total, size));
  return Array.from({ length: last }, (_, index) => index + 1);
}
