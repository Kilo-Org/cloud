import { afterEach, describe, expect, it, vi } from 'vitest';
import { GitLabTokenService } from './gitlab-token-service.js';

describe('GitLabTokenService', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('refreshes OAuth tokens against a safe instance base path', async () => {
    const fetch = vi.fn().mockResolvedValue(
      Response.json({
        access_token: 'refreshed-access-token',
        refresh_token: 'refreshed-refresh-token',
        token_type: 'bearer',
        expires_in: 3600,
        created_at: 1_800_000_000,
        scope: 'api',
      })
    );
    vi.stubGlobal('fetch', fetch);
    const service = new GitLabTokenService({
      GITLAB_CLIENT_ID: 'client-id',
      GITLAB_CLIENT_SECRET: 'client-secret',
    } as unknown as CloudflareEnv);
    vi.spyOn(service as any, 'updateIntegrationMetadata').mockResolvedValue(undefined);

    await expect(
      service.getToken('integration_1', {
        access_token: 'expired-access-token',
        refresh_token: 'refresh-token',
        token_expires_at: '2020-01-01T00:00:00.000Z',
        auth_type: 'oauth',
        gitlab_instance_url: 'https://gitlab.example.com:8443/gitlab/',
      })
    ).resolves.toEqual({
      success: true,
      token: 'refreshed-access-token',
      instanceUrl: 'https://gitlab.example.com:8443/gitlab',
    });
    expect(fetch).toHaveBeenCalledWith('https://gitlab.example.com:8443/gitlab/oauth/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        client_id: 'client-id',
        client_secret: 'client-secret',
        refresh_token: 'refresh-token',
        grant_type: 'refresh_token',
      }),
    });
  });

  it('rejects unsafe refresh targets before sending OAuth credentials', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);

    await expect(
      new GitLabTokenService({} as CloudflareEnv).getToken('integration_1', {
        access_token: 'expired-access-token',
        refresh_token: 'refresh-token',
        token_expires_at: '2020-01-01T00:00:00.000Z',
        auth_type: 'oauth',
        gitlab_instance_url:
          'https://gitlab.example.com/gitlab?redirect=https://attacker.example.com',
      })
    ).resolves.toEqual({ success: false, reason: 'invalid_instance_url' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('does not log provider response bodies when refresh fails', async () => {
    const text = vi.fn().mockResolvedValue('body includes token secret');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, text }));
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await expect(
      new GitLabTokenService({
        GITLAB_CLIENT_ID: 'client-id',
        GITLAB_CLIENT_SECRET: 'client-secret',
      } as unknown as CloudflareEnv).getToken('integration_1', {
        access_token: 'expired-access-token',
        refresh_token: 'refresh-token',
        token_expires_at: '2020-01-01T00:00:00.000Z',
        auth_type: 'oauth',
      })
    ).resolves.toEqual({ success: false, reason: 'token_refresh_failed' });
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain('body includes token secret');
    expect(text).not.toHaveBeenCalled();
  });
});
