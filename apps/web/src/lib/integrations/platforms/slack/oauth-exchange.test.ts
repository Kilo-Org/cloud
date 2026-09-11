import { beforeEach, describe, expect, it, jest } from '@jest/globals';

const mockAccess = jest.fn<(input: Record<string, string>) => Promise<unknown>>();

jest.mock('@/lib/config.server', () => ({
  SLACK_CLIENT_ID: 'client-id',
  SLACK_CLIENT_SECRET: 'client-secret',
}));

import { exchangeSlackOAuthCode } from './oauth-exchange';

describe('exchangeSlackOAuthCode', () => {
  beforeEach(() => {
    mockAccess.mockReset();
  });

  it('validates and converts a workspace OAuth response without exposing extra fields', async () => {
    mockAccess.mockResolvedValue({
      ok: true,
      access_token: 'xoxb-secret',
      bot_user_id: 'U_BOT',
      scope: 'chat:write, app_mentions:read',
      team: { id: 'T_TEAM', name: 'Workspace' },
      authed_user: { access_token: 'xoxp-ignored' },
    });

    await expect(
      exchangeSlackOAuthCode('code', 'https://example.test/callback', mockAccess)
    ).resolves.toEqual({
      teamId: 'T_TEAM',
      installation: {
        botToken: 'xoxb-secret',
        botUserId: 'U_BOT',
        teamName: 'Workspace',
      },
      grantedScopes: ['chat:write', 'app_mentions:read'],
    });
    expect(mockAccess).toHaveBeenCalledWith({
      client_id: expect.any(String),
      client_secret: expect.any(String),
      code: 'code',
      redirect_uri: 'https://example.test/callback',
    });
  });

  it('uses the enterprise identity for an org-wide installation', async () => {
    mockAccess.mockResolvedValue({
      ok: true,
      access_token: 'xoxb-enterprise',
      enterprise: { id: 'E_GRID', name: 'Grid' },
      is_enterprise_install: true,
    });

    await expect(
      exchangeSlackOAuthCode('code', 'https://example.test/callback', mockAccess)
    ).resolves.toMatchObject({
      teamId: 'E_GRID',
      installation: {
        enterpriseId: 'E_GRID',
        isEnterpriseInstall: true,
        teamName: 'Grid',
      },
    });
  });

  it('fails closed on malformed successful responses', async () => {
    mockAccess.mockResolvedValue({ ok: true, access_token: 'xoxb-secret' });
    await expect(
      exchangeSlackOAuthCode('code', 'https://example.test/callback', mockAccess)
    ).rejects.toThrow('did not identify an installation');
  });
});
