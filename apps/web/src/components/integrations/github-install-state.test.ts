import { describe, expect, test } from '@jest/globals';

import { buildGitHubInstallState } from './github-install-state';

describe('buildGitHubInstallState', () => {
  test('returns a bare database token', () => {
    expect(buildGitHubInstallState('db-token-abc123')).toBe('db-token-abc123');
  });
});
