import { describe, expect, test } from '@jest/globals';

import { buildGitHubInstallState } from './github-install-state';

describe('buildGitHubInstallState', () => {
  test('keeps normal integration installs unchanged', () => {
    expect(buildGitHubInstallState('user_123')).toBe('user_123');
  });

  test('adds an encoded app-specific return path', () => {
    expect(buildGitHubInstallState('org_123', '/github-app?organizationId=org_123')).toBe(
      'org_123|return=%2Fgithub-app%3ForganizationId%3Dorg_123'
    );
  });
});
