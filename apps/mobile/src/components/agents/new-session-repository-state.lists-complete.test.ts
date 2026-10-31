import { describe, expect, it } from 'vitest';

import {
  areRepositoryListsComplete,
  type RepositoryGroup,
  type RepositoryProviderStatus,
} from './new-session-repository-state';

function group(
  status: RepositoryProviderStatus,
  notice?: RepositoryGroup['notice']
): RepositoryGroup {
  return {
    key: 'github',
    status,
    repositories: [],
    ...(notice === undefined ? {} : { notice }),
  };
}

describe('areRepositoryListsComplete', () => {
  it('is complete when every provider answered, an empty list included', () => {
    expect(areRepositoryListsComplete([group('repos'), group('connected-empty')])).toBe(true);
    expect(areRepositoryListsComplete([group('repos'), group('connect')])).toBe(true);
  });

  it('is incomplete while a read can omit rows', () => {
    // Still loading, still failing, partial installations, and a connected
    // provider that cannot be read right now each leave rows unaccounted for.
    for (const status of ['loading', 'error', 'unavailable'] as const) {
      expect(areRepositoryListsComplete([group('repos'), group(status)]), status).toBe(false);
    }
    expect(areRepositoryListsComplete([group('repos', 'partial')])).toBe(false);
  });

  it('is incomplete with no provider groups at all', () => {
    expect(areRepositoryListsComplete([])).toBe(false);
  });
});
