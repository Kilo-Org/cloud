import { describe, expect, it } from 'vitest';

import { shouldShowRunOnSelector } from './should-show-run-on-selector';

describe('shouldShowRunOnSelector', () => {
  it('shows the selector on a personal flow (no organizationId)', () => {
    expect(shouldShowRunOnSelector(undefined)).toBe(true);
  });

  it('hides the selector on an org-scoped flow (organizationId present)', () => {
    expect(shouldShowRunOnSelector('org-123')).toBe(false);
  });

  it('treats an empty-string organizationId as still-scoped (defensive)', () => {
    // `useLocalSearchParams` returns strings, not null, so an empty string
    // is a real possibility. We treat it as scoped (hidden) — the route
    // never pushes an empty value intentionally, but if one arrives we
    // must not silently fall through to the personal path.
    expect(shouldShowRunOnSelector('')).toBe(false);
  });
});
