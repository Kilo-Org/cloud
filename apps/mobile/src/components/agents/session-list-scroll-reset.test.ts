import { describe, expect, it } from 'vitest';

import { shouldResetScrollOnCommittedQuery } from './session-list-scroll-reset';

describe('shouldResetScrollOnCommittedQuery', () => {
  it('returns false on initial mount (prev is null)', () => {
    expect(shouldResetScrollOnCommittedQuery(null, '')).toBe(false);
    expect(shouldResetScrollOnCommittedQuery(null, 'foo')).toBe(false);
  });

  it('returns false when the committed query is unchanged', () => {
    expect(shouldResetScrollOnCommittedQuery('', '')).toBe(false);
    expect(shouldResetScrollOnCommittedQuery('foo', 'foo')).toBe(false);
  });

  it('returns true when the committed query changes', () => {
    expect(shouldResetScrollOnCommittedQuery('foo', 'bar')).toBe(true);
  });

  it('treats empty-string ↔ non-empty transitions as a change', () => {
    expect(shouldResetScrollOnCommittedQuery('', 'foo')).toBe(true);
    expect(shouldResetScrollOnCommittedQuery('foo', '')).toBe(true);
  });
});
