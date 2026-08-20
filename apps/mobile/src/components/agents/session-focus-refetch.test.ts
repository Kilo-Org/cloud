import { describe, expect, it } from 'vitest';

import { shouldRefetchOnFocus } from '@/components/agents/session-focus-refetch';

describe('shouldRefetchOnFocus', () => {
  it('returns false on the first focus of a session id', () => {
    expect(shouldRefetchOnFocus(null, 'session-a')).toBe(false);
  });

  it('returns true on a second focus of the same session id', () => {
    expect(shouldRefetchOnFocus('session-a', 'session-a')).toBe(true);
  });

  it('returns false again on a focus of a different session id', () => {
    expect(shouldRefetchOnFocus('session-a', 'session-b')).toBe(false);
  });
});
