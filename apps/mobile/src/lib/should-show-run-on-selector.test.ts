import { describe, expect, it } from 'vitest';

import { shouldShowRunOnSelector } from './should-show-run-on-selector';

describe('shouldShowRunOnSelector', () => {
  it('shows the selector on a personal flow (organizationId undefined)', () => {
    expect(shouldShowRunOnSelector(undefined)).toBe(true);
  });

  it('shows the selector when organizationId is null (share-gate personal)', () => {
    expect(shouldShowRunOnSelector(null)).toBe(true);
  });

  it('shows the selector on an org-scoped flow (organizationId present)', () => {
    expect(shouldShowRunOnSelector('org-123')).toBe(true);
  });

  it('shows the selector for an empty-string organizationId', () => {
    expect(shouldShowRunOnSelector('')).toBe(true);
  });
});
