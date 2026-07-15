import { describe, expect, it } from 'vitest';

import { shouldShowRepositoryError } from './new-session-repository-state';

describe('shouldShowRepositoryError', () => {
  it('keeps cached repositories visible after a background refetch error', () => {
    expect(shouldShowRepositoryError({ isError: true, repositoryCount: 1 })).toBe(false);
  });

  it('shows the error when no cached repositories are available', () => {
    expect(shouldShowRepositoryError({ isError: true, repositoryCount: 0 })).toBe(true);
  });
});
