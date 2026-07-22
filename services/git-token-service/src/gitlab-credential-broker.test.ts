import { describe, expect, it, vi } from 'vitest';
import { GitLabCredentialBroker } from './gitlab-credential-broker.js';

describe('GitLabCredentialBroker', () => {
  it('returns an encrypted credential', async () => {
    const broker = new GitLabCredentialBroker({
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
  });

  it('maps a missing integration credential to reconnect_required', async () => {
    const broker = new GitLabCredentialBroker({
      getEncryptedCredential: async () => ({ status: 'credential_absent' }),
      hasProjectCredentialCandidates: vi.fn().mockResolvedValue(false),
    });

    await expect(
      broker.resolveCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: 'integration-1' }
      )
    ).resolves.toEqual({ status: 'reconnect_required' });
  });

  it('maps a missing exact project credential to not_connected', async () => {
    const broker = new GitLabCredentialBroker({
      getEncryptedCredential: async () => ({ status: 'credential_absent' }),
      hasProjectCredentialCandidates: vi.fn().mockResolvedValue(false),
    });

    await expect(
      broker.resolveCredential(
        { userId: 'user-1' },
        { credential: 'project-exact', integrationId: 'integration-1', projectId: '42' }
      )
    ).resolves.toEqual({ status: 'not_connected' });
  });

  it('passes through other encrypted-credential failures unchanged', async () => {
    const broker = new GitLabCredentialBroker({
      getEncryptedCredential: async () => ({ status: 'reconnect_required' }),
      hasProjectCredentialCandidates: vi.fn().mockResolvedValue(false),
    });

    await expect(
      broker.resolveCredential(
        { userId: 'user-1' },
        { credential: 'integration', integrationId: 'integration-1' }
      )
    ).resolves.toEqual({ status: 'reconnect_required' });
  });
});
