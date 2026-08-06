import { describe, expect, it } from 'vitest';

import { selectActiveExclusionIds } from '@/lib/active-sessions-live';

type Row = { id: string; organizationId?: string | null };

describe('selectActiveExclusionIds', () => {
  it('includes every row id regardless of org attribution', () => {
    const rows: Row[] = [
      { id: 'a' },
      { id: 'b', organizationId: null },
      { id: 'c', organizationId: 'org-1' },
    ];
    const ids = selectActiveExclusionIds(rows);
    expect([...ids].toSorted()).toEqual(['a', 'b', 'c']);
  });

  it('collapses duplicate ids into one set entry', () => {
    const ids = selectActiveExclusionIds([{ id: 'x' }, { id: 'x' }, { id: 'y' }]);
    expect(ids.size).toBe(2);
    expect([...ids].toSorted()).toEqual(['x', 'y']);
  });

  it('returns an empty set for an empty cache', () => {
    expect(selectActiveExclusionIds([]).size).toBe(0);
  });
});
