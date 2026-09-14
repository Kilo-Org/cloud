import { describe, expect, it } from 'vitest';

import { filterButtonAccessibilityLabel } from './session-filter-button-label';

describe('filterButtonAccessibilityLabel', () => {
  it('announces only the title while no filters are applied', () => {
    expect(filterButtonAccessibilityLabel('Filter sessions', 0)).toBe('Filter sessions');
  });

  it('appends the applied-filter count while the list is narrowed', () => {
    expect(filterButtonAccessibilityLabel('Filter sessions', 1)).toBe('Filter sessions, 1');
    expect(filterButtonAccessibilityLabel('Filter sessions', 3)).toBe('Filter sessions, 3');
  });

  it('drops the count again once every filter is cleared', () => {
    expect(filterButtonAccessibilityLabel('Filter sessions', 2)).toBe('Filter sessions, 2');
    expect(filterButtonAccessibilityLabel('Filter sessions', 0)).toBe('Filter sessions');
  });
});
