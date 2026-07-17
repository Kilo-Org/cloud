import { describe, expect, it, vi } from 'vitest';
import { resolveGitLabRuntimeToken } from './gitlab-runtime-token-resolver.js';

describe('resolveGitLabRuntimeToken one-way credentials', () => {
  it('resolves an OAuth integration through the unified resolver and fences only its stable ID', async () => {
    const integrationId = '123e4567-e89b-12d3-a456-426614174011';
    const credentialResolver = {
      resolveCredential: vi.fn().mockResolvedValue({
        status: 'available',
        token: 'encrypted-oauth-token',
        instanceUrl: 'https://gitlab.example.com',
        glabIsOAuth2: true,
        integrationId,
        credentialId: '123e4567-e89b-12d3-a456-426614174012',
        credentialVersion: 4,
        source: { type: 'integration' },
      }),
    };
    const lookupService = {
      findGitLabIntegration: vi.fn().mockResolvedValue({
        success: true,
        integrationId,
        integrationType: 'oauth',
        accountId: '42',
        accountLogin: 'octocat',
        metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
      }),
      findAuthorizedGitLabIntegrations: vi.fn(),
    };

    await expect(
      resolveGitLabRuntimeToken({ userId: 'user-1' }, { lookupService, credentialResolver })
    ).resolves.toEqual({
      success: true,
      token: 'encrypted-oauth-token',
      instanceUrl: 'https://gitlab.example.com',
      glabIsOAuth2: true,
      integrationId,
      source: {
        type: 'integration',
        credentialId: '123e4567-e89b-12d3-a456-426614174012',
      },
    });
  });
});
