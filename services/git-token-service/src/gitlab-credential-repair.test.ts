import { describe, expect, it, vi } from 'vitest';
import { getWorkerDb } from '@kilocode/db/client';
import {
  GitLabCredentialRepairService,
  buildGitLabCredentialRepairQuery,
  type GitLabCredentialRepairRow,
  type GitLabCredentialRepairStore,
} from './gitlab-credential-repair.js';

const timestamp = '2026-07-13T12:00:00.000Z';

function repairRow(): GitLabCredentialRepairRow {
  return {
    parent: {
      id: 'integration-1',
      platform: 'gitlab',
      integration_type: 'oauth',
      platform_account_id: '42',
      platform_account_login: 'octocat',
      owned_by_user_id: 'user-1',
      owned_by_organization_id: null,
      metadata: { gitlab_instance_url: 'https://gitlab.example.com' },
    },
    credential: {
      id: 'credential-1',
      platform_integration_id: 'integration-1',
      authorized_by_user_id: 'user-1',
      provider_subject_id: '42',
      provider_subject_login: 'octocat',
      provider_base_url: 'https://gitlab.example.com',
      access_token_encrypted: 'access-v2',
      access_token_expires_at: timestamp,
      refresh_token_encrypted: 'refresh-v2',
      refresh_token_expires_at: null,
      oauth_client_secret_encrypted: 'client-secret-v1',
      credential_version: 2,
      revoked_at: null,
      revocation_reason: null,
      last_used_at: null,
      created_at: timestamp,
      updated_at: timestamp,
    },
  };
}

function store() {
  return {
    listCandidates: vi.fn().mockResolvedValue({ rows: [repairRow()], nextCursor: null }),
    rewrapClientSecret: vi.fn().mockResolvedValue(true),
  } satisfies GitLabCredentialRepairStore;
}

describe('GitLabCredentialRepairService', () => {
  it('selects only versioned custom GitLab OAuth client secrets in key order', () => {
    const query = buildGitLabCredentialRepairQuery(
      getWorkerDb('postgres://query-builder'),
      '123e4567-e89b-12d3-a456-426614174099'
    ).toSQL();

    expect(query.sql).toContain('inner join "platform_integrations"');
    expect(query.sql).toContain('"platform_integrations"."platform" =');
    expect(query.sql).toContain('"platform_integrations"."integration_type" =');
    expect(query.sql).toContain('"oauth_client_secret_encrypted" is not null');
    expect(query.sql).toContain('"credential_version" >');
    expect(query.sql).toContain('order by "platform_oauth_credentials"."id" asc');
    expect(query.params).toEqual(expect.arrayContaining(['gitlab', 'oauth', 1]));
  });

  it('rewraps a previous-version custom client secret with current-version AAD', async () => {
    const repairStore = store();
    const crypto = {
      auditDecrypt: vi
        .fn()
        .mockResolvedValueOnce({ status: 'decrypt_failed' })
        .mockResolvedValueOnce({ status: 'available', token: 'custom-client-secret' }),
      encrypt: vi.fn().mockResolvedValue({
        status: 'available',
        ciphertext: 'client-secret-v2',
      }),
    };

    await expect(
      new GitLabCredentialRepairService(repairStore, crypto).repair({ limit: 100 })
    ).resolves.toEqual(
      expect.objectContaining({
        counts: expect.objectContaining({ candidates: 1, repaired: 1, alreadyHealthy: 0 }),
        nextCursor: null,
      })
    );

    expect(crypto.auditDecrypt).toHaveBeenCalledTimes(2);
    expect(crypto.auditDecrypt.mock.calls[0]?.[0].aad).toContain('"credentialVersion":2');
    expect(crypto.auditDecrypt.mock.calls[1]?.[0].aad).toContain('"credentialVersion":1');
    expect(crypto.encrypt).toHaveBeenCalledWith(
      expect.objectContaining({
        plaintext: 'custom-client-secret',
        aad: expect.stringContaining('"credentialVersion":2'),
      })
    );
    expect(repairStore.rewrapClientSecret).toHaveBeenCalledWith({
      credentialId: 'credential-1',
      credentialVersion: 2,
      previousCiphertext: 'client-secret-v1',
      nextCiphertext: 'client-secret-v2',
    });
  });

  it('leaves an already healthy current-version client secret unchanged', async () => {
    const repairStore = store();
    const crypto = {
      auditDecrypt: vi.fn().mockResolvedValue({ status: 'available', token: 'client-secret' }),
      encrypt: vi.fn(),
    };

    const result = await new GitLabCredentialRepairService(repairStore, crypto).repair({
      limit: 100,
    });

    expect(result.counts).toEqual(
      expect.objectContaining({ candidates: 1, repaired: 0, alreadyHealthy: 1 })
    );
    expect(crypto.auditDecrypt).toHaveBeenCalledTimes(1);
    expect(crypto.encrypt).not.toHaveBeenCalled();
    expect(repairStore.rewrapClientSecret).not.toHaveBeenCalled();
  });

  it('does not rewrite a client secret that fails both current and previous-version AAD', async () => {
    const repairStore = store();
    const crypto = {
      auditDecrypt: vi.fn().mockResolvedValue({ status: 'decrypt_failed' }),
      encrypt: vi.fn(),
    };

    const result = await new GitLabCredentialRepairService(repairStore, crypto).repair({
      limit: 100,
    });

    expect(result.counts.unrepairableFailures).toBe(1);
    expect(result.failures.unrepairable).toEqual([
      { integrationId: 'integration-1', credentialId: 'credential-1' },
    ]);
    expect(crypto.encrypt).not.toHaveBeenCalled();
    expect(repairStore.rewrapClientSecret).not.toHaveBeenCalled();
  });
});
