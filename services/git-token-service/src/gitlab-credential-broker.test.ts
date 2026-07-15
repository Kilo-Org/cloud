import { describe, expect, it, vi } from 'vitest';
import { GitLabCredentialBroker } from './gitlab-credential-broker.js';

describe('GitLabCredentialBroker', () => {
  it('returns an encrypted credential without reading legacy plaintext', async () => {
    const findIntegration = vi.fn();
    const broker = new GitLabCredentialBroker({
      findIntegration,
      getLegacyIntegrationToken: vi.fn(),
      getEncryptedCredential: async () => ({
        status: 'available',
        token: 'encrypted-secret',
        instanceUrl: 'https://gitlab.example.com',
        integrationId: 'integration-1',
        glabIsOAuth2: true,
        credentialId: 'credential-1',
        credentialVersion: 1,
        source: { type: 'integration' },
      }),
      hasProjectCredentialCandidates: vi.fn().mockResolvedValue(false),
      reportFallback: vi.fn(),
    });

    await expect(
      broker.resolveCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: 'integration-1' }
      )
    ).resolves.toEqual({
      status: 'available',
      token: 'encrypted-secret',
      instanceUrl: 'https://gitlab.example.com',
      glabIsOAuth2: true,
      integrationId: 'integration-1',
      credentialId: 'credential-1',
      credentialVersion: 1,
      source: { type: 'integration' },
    });
    expect(findIntegration).not.toHaveBeenCalled();
  });

  it('returns the matching legacy integration token only when the encrypted row is absent', async () => {
    const reportFallback = vi.fn();
    const broker = new GitLabCredentialBroker({
      findIntegration: async () => ({
        success: true,
        integrationId: 'integration-1',
        integrationType: 'pat',
        accountId: '123',
        accountLogin: 'octocat',
        metadata: {
          access_token: 'legacy-secret',
          auth_type: 'pat',
          gitlab_instance_url: 'https://gitlab.example.com',
        },
      }),
      getLegacyIntegrationToken: async () => ({
        success: true,
        token: 'legacy-secret',
        instanceUrl: 'https://gitlab.example.com',
      }),
      getEncryptedCredential: async () => ({ status: 'credential_absent' }),
      hasProjectCredentialCandidates: vi.fn().mockResolvedValue(false),
      reportFallback,
    });

    await expect(
      broker.resolveCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: 'integration-1' }
      )
    ).resolves.toEqual({
      status: 'available',
      token: 'legacy-secret',
      instanceUrl: 'https://gitlab.example.com',
      glabIsOAuth2: false,
      integrationId: 'integration-1',
      source: { type: 'integration' },
    });
    expect(reportFallback).toHaveBeenCalledWith({
      integrationId: 'integration-1',
      credential: 'integration',
      status: 'resolved',
    });
    expect(JSON.stringify(reportFallback.mock.calls)).not.toContain('legacy-secret');
  });

  it('fails closed without reading plaintext when an encrypted row is invalid', async () => {
    const findIntegration = vi.fn();
    const getLegacyIntegrationToken = vi.fn();
    const broker = new GitLabCredentialBroker({
      findIntegration,
      getLegacyIntegrationToken,
      getEncryptedCredential: async () => ({ status: 'reconnect_required' }),
      hasProjectCredentialCandidates: vi.fn().mockResolvedValue(false),
      reportFallback: vi.fn(),
    });

    await expect(
      broker.resolveCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: 'integration-1' }
      )
    ).resolves.toEqual({ status: 'reconnect_required' });
    expect(findIntegration).not.toHaveBeenCalled();
    expect(getLegacyIntegrationToken).not.toHaveBeenCalled();
  });

  it('falls back to only the exact legacy project token when its encrypted row is absent', async () => {
    const getLegacyIntegrationToken = vi.fn();
    const broker = new GitLabCredentialBroker({
      findIntegration: async () => ({
        success: true,
        integrationId: 'integration-1',
        integrationType: 'oauth',
        accountId: '123',
        accountLogin: 'octocat',
        metadata: {
          access_token: 'integration-secret',
          auth_type: 'oauth',
          gitlab_instance_url: 'https://gitlab.example.com',
          project_tokens: { '42': { token: 'legacy-project-secret' } },
        },
      }),
      getLegacyIntegrationToken,
      getEncryptedCredential: async () => ({ status: 'credential_absent' }),
      hasProjectCredentialCandidates: vi.fn().mockResolvedValue(false),
      reportFallback: vi.fn(),
    });

    await expect(
      broker.resolveCredential(
        { userId: 'user-1' },
        { credential: 'project-exact', integrationId: 'integration-1', projectId: '42' }
      )
    ).resolves.toEqual({
      status: 'available',
      token: 'legacy-project-secret',
      instanceUrl: 'https://gitlab.example.com',
      glabIsOAuth2: false,
      integrationId: 'integration-1',
      source: { type: 'project', projectId: '42' },
    });
    expect(getLegacyIntegrationToken).not.toHaveBeenCalled();
  });
});
