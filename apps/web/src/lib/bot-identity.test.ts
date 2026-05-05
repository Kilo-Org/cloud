import { describe, expect, test } from '@jest/globals';
import { githubUserIdentity, GITHUB_USER_IDENTITY_TEAM_ID } from '@/lib/bot-identity';
import { PLATFORM } from '@/lib/integrations/core/constants';

describe('bot identity helpers', () => {
  test('builds user-level GitHub bot identities for account links', () => {
    expect(githubUserIdentity('12345')).toEqual({
      platform: PLATFORM.GITHUB,
      teamId: GITHUB_USER_IDENTITY_TEAM_ID,
      userId: '12345',
    });
  });
});
