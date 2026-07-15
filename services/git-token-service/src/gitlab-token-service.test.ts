import { describe, expect, it, vi } from 'vitest';
import { GitLabTokenService } from './gitlab-token-service.js';

describe('GitLabTokenService', () => {
  it('delegates an expired legacy OAuth token to encrypted promotion', async () => {
    const promoteLegacy = vi.fn().mockResolvedValue({
      status: 'available',
      token: 'refreshed-access-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
    });
    const service = new GitLabTokenService({}, { promoteLegacy });

    await expect(
      service.getToken(
        'integration-1',
        {
          access_token: 'expired-access-token',
          refresh_token: 'refresh-token',
          token_expires_at: '2020-01-01T00:00:00.000Z',
          auth_type: 'oauth',
          gitlab_instance_url: 'https://gitlab.example.com/gitlab',
        },
        { userId: 'user-1' }
      )
    ).resolves.toEqual({
      success: true,
      token: 'refreshed-access-token',
      instanceUrl: 'https://gitlab.example.com/gitlab',
    });
    expect(promoteLegacy).toHaveBeenCalledWith({
      actor: { userId: 'user-1' },
      integrationId: 'integration-1',
    });
  });
});
