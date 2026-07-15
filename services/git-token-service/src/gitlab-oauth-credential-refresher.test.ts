import { beforeEach, describe, expect, it, vi } from 'vitest';
import { platform_integrations, platform_oauth_credentials } from '@kilocode/db/schema';
import { GitLabCredentialCrypto } from './gitlab-credential-crypto.js';
import { GitLabOAuthCredentialRefresher } from './gitlab-oauth-credential-refresher.js';

const { getWorkerDbMock } = vi.hoisted(() => ({ getWorkerDbMock: vi.fn() }));

vi.mock('@kilocode/db/client', () => ({ getWorkerDb: getWorkerDbMock }));

function refreshInput() {
  return {
    actor: { userId: 'user-1' },
    owner: { type: 'user' as const, id: 'user-1' },
    parent: {
      integrationId: 'integration-1',
      platform: 'gitlab',
      integrationType: 'oauth',
      integrationStatus: 'active',
      ownedByUserId: 'user-1',
      ownedByOrganizationId: null,
      providerBaseUrl: 'https://gitlab.example.com',
    },
    credential: {
      id: 'credential-1',
      platform_integration_id: 'integration-1',
      authorized_by_user_id: 'user-1',
      provider_subject_id: '123',
      provider_subject_login: 'octocat',
      provider_base_url: 'https://gitlab.example.com',
      access_token_encrypted: 'encrypted-access',
      access_token_expires_at: '2020-01-01T00:00:00.000Z',
      refresh_token_encrypted: 'encrypted-refresh',
      refresh_token_expires_at: null,
      oauth_client_secret_encrypted: null,
      credential_version: 1,
      revoked_at: null,
      revocation_reason: null,
      last_used_at: null,
      created_at: '2026-07-13T12:00:00.000Z',
      updated_at: '2026-07-13T12:00:00.000Z',
    },
  };
}

describe('GitLabOAuthCredentialRefresher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('classifies missing database configuration as temporary unavailability', async () => {
    await expect(new GitLabOAuthCredentialRefresher({}).refresh(refreshInput())).resolves.toEqual({
      status: 'temporarily_unavailable',
    });
  });

  it('rejects a replacement credential row even when its version matches the candidate', async () => {
    const input = refreshInput();
    const loaded = {
      credential: {
        ...input.credential,
        id: 'replacement-credential',
        access_token_expires_at: '2099-01-01T00:00:00.000Z',
      },
      integrationId: input.parent.integrationId,
      platform: 'gitlab',
      integrationType: 'oauth',
      integrationStatus: 'active',
      ownedByUserId: 'user-1',
      ownedByOrganizationId: null,
      accountId: '123',
      accountLogin: 'octocat',
      metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
    };
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([loaded]) })),
          })),
        })),
      })),
    };
    getWorkerDbMock.mockReturnValue({
      transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx),
    });

    await expect(
      new GitLabOAuthCredentialRefresher({
        HYPERDRIVE: { connectionString: 'postgres://test' } as Hyperdrive,
      }).refresh(input)
    ).resolves.toEqual({ status: 'reconnect_required' });
  });

  it('refreshes encrypted credentials without rewriting plaintext', async () => {
    const input = refreshInput();
    const loaded = {
      credential: input.credential,
      integrationId: input.parent.integrationId,
      platform: 'gitlab',
      integrationType: 'oauth',
      integrationStatus: 'active',
      ownedByUserId: 'user-1',
      ownedByOrganizationId: null,
      accountId: '123',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'old-plaintext-access',
        refresh_token: 'old-plaintext-refresh',
        gitlab_instance_url: 'https://gitlab.example.com',
      },
    };
    const integrationUpdates: Record<string, unknown>[] = [];
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          innerJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([loaded]) })),
          })),
        })),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => {
            if (table === platform_integrations) {
              integrationUpdates.push(values);
              return Promise.resolve();
            }
            if (table === platform_oauth_credentials) {
              return { returning: vi.fn().mockResolvedValue([{ id: input.credential.id }]) };
            }
            throw new Error('Unexpected table');
          }),
        })),
      })),
    };
    getWorkerDbMock.mockReturnValue({
      transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx),
    });
    const crypto = new GitLabCredentialCrypto({});
    vi.spyOn(crypto, 'decrypt').mockResolvedValue({ status: 'available', token: 'refresh-token' });
    vi.spyOn(crypto, 'encrypt')
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-access-envelope' })
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-refresh-envelope' });

    await expect(
      new GitLabOAuthCredentialRefresher(
        {
          HYPERDRIVE: { connectionString: 'postgres://test' } as Hyperdrive,
          GITLAB_CLIENT_ID: 'client-id',
          GITLAB_CLIENT_SECRET: 'client-secret',
        },
        {
          crypto,
          now: () => new Date('2026-07-13T12:00:00.000Z'),
          fetch: vi.fn().mockResolvedValue(
            Response.json({
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              token_type: 'Bearer',
              expires_in: 3600,
              created_at: 1_784_118_000,
              scope: 'api read_user',
            })
          ),
        }
      ).refresh(input)
    ).resolves.toEqual({
      status: 'available',
      token: 'new-access-token',
      credentialVersion: 2,
    });
    expect(integrationUpdates).toEqual([
      expect.objectContaining({ integration_type: 'oauth', scopes: ['api', 'read_user'] }),
    ]);
    expect(integrationUpdates[0]).not.toHaveProperty('metadata');
  });

  it('promotes an expired legacy OAuth credential into one encrypted row without rewriting plaintext', async () => {
    const insertedRows: Record<string, unknown>[] = [];
    const integrationUpdates: Record<string, unknown>[] = [];
    const loaded = {
      credential: null,
      integrationId: 'integration-1',
      platform: 'gitlab',
      integrationType: 'oauth',
      integrationStatus: 'active',
      ownedByUserId: 'user-1',
      ownedByOrganizationId: null,
      accountId: '123',
      accountLogin: 'octocat',
      metadata: {
        access_token: 'legacy-access-token',
        refresh_token: 'legacy-refresh-token',
        token_expires_at: '2020-01-01T00:00:00.000Z',
        gitlab_instance_url: 'https://gitlab.example.com',
        auth_type: 'oauth',
      },
    };
    const tx = {
      execute: vi.fn(),
      select: vi.fn(() => ({
        from: vi.fn(() => ({
          leftJoin: vi.fn(() => ({
            where: vi.fn(() => ({ limit: vi.fn().mockResolvedValue([loaded]) })),
          })),
        })),
      })),
      insert: vi.fn(() => ({
        values: vi.fn((values: Record<string, unknown>) => {
          insertedRows.push(values);
          return {
            onConflictDoNothing: vi.fn(() => ({
              returning: vi.fn().mockResolvedValue([{ id: values.id }]),
            })),
          };
        }),
      })),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => ({
          where: vi.fn(() => {
            if (table === platform_integrations) integrationUpdates.push(values);
            return Promise.resolve();
          }),
        })),
      })),
    };
    getWorkerDbMock.mockReturnValue({
      transaction: (callback: (transaction: typeof tx) => unknown) => callback(tx),
    });
    const crypto = new GitLabCredentialCrypto({});
    vi.spyOn(crypto, 'encrypt')
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'access-envelope' })
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'refresh-envelope' });

    await expect(
      new GitLabOAuthCredentialRefresher(
        {
          HYPERDRIVE: { connectionString: 'postgres://test' } as Hyperdrive,
          GITLAB_CLIENT_ID: 'client-id',
          GITLAB_CLIENT_SECRET: 'client-secret',
        },
        {
          crypto,
          now: () => new Date('2026-07-13T12:00:00.000Z'),
          fetch: vi.fn().mockResolvedValue(
            Response.json({
              access_token: 'new-access-token',
              refresh_token: 'new-refresh-token',
              token_type: 'Bearer',
              expires_in: 3600,
              created_at: 1_784_118_000,
              scope: 'api read_user',
            })
          ),
        }
      ).promoteLegacy({ actor: { userId: 'user-1' }, integrationId: 'integration-1' })
    ).resolves.toEqual({
      status: 'available',
      token: 'new-access-token',
      instanceUrl: 'https://gitlab.example.com',
    });
    expect(insertedRows).toEqual([
      expect.objectContaining({
        platform_integration_id: 'integration-1',
        access_token_encrypted: 'access-envelope',
        refresh_token_encrypted: 'refresh-envelope',
        credential_version: 1,
      }),
    ]);
    expect(JSON.stringify(insertedRows)).not.toContain('new-access-token');
    expect(integrationUpdates[0]).not.toHaveProperty('metadata');
  });
});
