import { describe, expect, it } from 'vitest';

import { partitionPendingItems } from '@/lib/pr-review/partition-pending-items';
import { type PendingReviewItem } from '@/lib/pr-review/pending-review-provider';

function makeItem(overrides: Partial<PendingReviewItem> = {}): PendingReviewItem {
  return {
    id: 'id-1',
    path: 'src/lib.ts',
    side: 'RIGHT',
    line: 7,
    body: 'Looks good.',
    commitSha: 'head-1',
    ...overrides,
  };
}

describe('partitionPendingItems', () => {
  it('marks every item fresh when all commit SHAs match the head', () => {
    const items = [
      makeItem({ id: 'a', commitSha: 'head-1' }),
      makeItem({ id: 'b', commitSha: 'head-1' }),
    ];
    const { fresh, stale } = partitionPendingItems(items, 'head-1');
    expect(fresh.map(item => item.id)).toEqual(['a', 'b']);
    expect(stale).toEqual([]);
  });

  it('marks every item stale when none match the head', () => {
    const items = [
      makeItem({ id: 'a', commitSha: 'head-0' }),
      makeItem({ id: 'b', commitSha: 'head-0' }),
    ];
    const { fresh, stale } = partitionPendingItems(items, 'head-1');
    expect(fresh).toEqual([]);
    expect(stale.map(item => item.id)).toEqual(['a', 'b']);
  });

  it('splits a mixed queue by commit SHA, preserving order within each side', () => {
    const items = [
      makeItem({ id: 'a', commitSha: 'head-1' }),
      makeItem({ id: 'b', commitSha: 'head-0' }),
      makeItem({ id: 'c', commitSha: 'head-1' }),
      makeItem({ id: 'd', commitSha: 'head-0' }),
    ];
    const { fresh, stale } = partitionPendingItems(items, 'head-1');
    expect(fresh.map(item => item.id)).toEqual(['a', 'c']);
    expect(stale.map(item => item.id)).toEqual(['b', 'd']);
  });

  it('treats an empty headSha as all fresh (overview not loaded)', () => {
    const items = [
      makeItem({ id: 'a', commitSha: 'head-0' }),
      makeItem({ id: 'b', commitSha: 'head-1' }),
    ];
    const { fresh, stale } = partitionPendingItems(items, '');
    expect(fresh.map(item => item.id)).toEqual(['a', 'b']);
    expect(stale).toEqual([]);
  });

  it('returns two empty lists for an empty queue', () => {
    const { fresh, stale } = partitionPendingItems([], 'head-1');
    expect(fresh).toEqual([]);
    expect(stale).toEqual([]);
  });
});
