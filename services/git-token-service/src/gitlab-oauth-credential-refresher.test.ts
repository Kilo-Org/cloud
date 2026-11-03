import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  platform_integrations,
  platform_oauth_credentials,
  oauth_refresh_exchange_leases,
} from '@kilocode/db/schema';
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

function loadedRow(
  input: ReturnType<typeof refreshInput>,
  overrides: {
    credential?: Partial<ReturnType<typeof refreshInput>['credential']>;
    metadata?: Record<string, unknown>;
  } = {}
) {
  return {
    credential: { ...input.credential, ...overrides.credential },
    integrationId: input.parent.integrationId,
    platform: 'gitlab',
    integrationType: 'oauth',
    integrationStatus: 'active',
    ownedByUserId: 'user-1',
    ownedByOrganizationId: null,
    accountId: '123',
    accountLogin: 'octocat',
    metadata: { gitlab_instance_url: 'https://gitlab.example.com', ...overrides.metadata },
  };
}

/**
 * Lease stubs for fakes that do not model refresh leases: the claim is granted
 * and the release reports that this attempt still held it.
 */
function grantedLeaseStubs() {
  return {
    insert: vi.fn(() => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(async () => [{ attemptId: values.attempt_id as string }]),
        })),
      })),
    })),
    delete: vi.fn(() => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => [{ credentialId: 'credential-1' }]),
      })),
    })),
  };
}

/**
 * Fake worker database that serves one row per `select()` call in order and
 * records whether a transaction is open, so a test can assert the provider
 * call never runs inside one.
 */
function installDatabase(rows: Array<Record<string, unknown> | undefined>) {
  // A single row models a credential that does not change across reads; several
  // rows are served in order so a test can model a row that another request
  // rotated between two reads.
  const state = {
    depth: 0,
    selectCount: 0,
    credentialUpdates: [] as Record<string, unknown>[],
    integrationUpdates: [] as Record<string, unknown>[],
    leases: new Map<string, string>(),
    releaseDenied: false,
  };
  const tx = {
    execute: vi.fn(async () => {
      if (state.depth !== 1) throw new Error('advisory lock taken outside a transaction');
    }),
    insert: vi.fn((table: unknown) => ({
      values: vi.fn((values: Record<string, unknown>) => ({
        onConflictDoUpdate: vi.fn(() => ({
          returning: vi.fn(async () => {
            if (table !== oauth_refresh_exchange_leases) throw new Error('Unexpected table');
            const credentialId = values.platform_oauth_credential_id as string;
            const attemptId = values.attempt_id as string;
            if (state.leases.has(credentialId)) return [];
            state.leases.set(credentialId, attemptId);
            return [{ attemptId }];
          }),
        })),
      })),
    })),
    delete: vi.fn((table: unknown) => ({
      where: vi.fn(() => ({
        returning: vi.fn(async () => {
          if (table !== oauth_refresh_exchange_leases) throw new Error('Unexpected table');
          if (state.releaseDenied) return [];
          const credentialIds = [...state.leases.keys()];
          state.leases.clear();
          return credentialIds.map(credentialId => ({ credentialId }));
        }),
      })),
    })),
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        innerJoin: vi.fn(() => ({
          where: vi.fn(() => ({
            limit: vi.fn(async () => {
              if (rows.length === 1) {
                const only = rows[0];
                return only === undefined ? [] : [only];
              }
              const row = rows[state.selectCount];
              state.selectCount += 1;
              return row === undefined ? [] : [row];
            }),
          })),
        })),
      })),
    })),
    update: vi.fn((table: unknown) => ({
      set: vi.fn((values: Record<string, unknown>) => ({
        where: vi.fn(() => {
          if (table === platform_integrations) {
            state.integrationUpdates.push(values);
            return Promise.resolve();
          }
          if (table === platform_oauth_credentials) {
            state.credentialUpdates.push(values);
            return { returning: vi.fn(async () => [{ id: 'credential-1' }]) };
          }
          throw new Error('Unexpected table');
        }),
      })),
    })),
  };
  getWorkerDbMock.mockReturnValue({
    transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => {
      state.depth += 1;
      try {
        return await callback(tx);
      } finally {
        state.depth -= 1;
      }
    },
  });
  return state;
}

function refreshedTokenResponse() {
  return Response.json({
    access_token: 'new-access-token',
    refresh_token: 'new-refresh-token',
    token_type: 'Bearer',
    expires_in: 3600,
    created_at: 1_784_118_000,
    scope: 'api read_user',
  });
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
      ...grantedLeaseStubs(),
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
    const credentialUpdates: Record<string, unknown>[] = [];
    const tx = {
      execute: vi.fn(),
      ...grantedLeaseStubs(),
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
              credentialUpdates.push(values);
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
    expect(credentialUpdates[0]).not.toHaveProperty('oauth_client_secret_encrypted');
  });

  it('re-encrypts a custom OAuth client secret with the next credential version', async () => {
    const baseInput = refreshInput();
    const input = {
      ...baseInput,
      credential: {
        ...baseInput.credential,
        oauth_client_secret_encrypted: 'encrypted-client-secret',
      },
    };
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
        client_id: 'custom-client-id',
        gitlab_instance_url: 'https://gitlab.example.com',
      },
    };
    const credentialUpdates: Record<string, unknown>[] = [];
    const tx = {
      execute: vi.fn(),
      ...grantedLeaseStubs(),
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
            if (table === platform_integrations) return Promise.resolve();
            if (table === platform_oauth_credentials) {
              credentialUpdates.push(values);
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
    vi.spyOn(crypto, 'decrypt')
      .mockResolvedValueOnce({ status: 'available', token: 'refresh-token' })
      .mockResolvedValueOnce({ status: 'available', token: 'custom-client-secret' });
    const encrypt = vi
      .spyOn(crypto, 'encrypt')
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-access-envelope' })
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-refresh-envelope' })
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-client-secret-envelope' });

    await expect(
      new GitLabOAuthCredentialRefresher(
        { HYPERDRIVE: { connectionString: 'postgres://test' } as Hyperdrive },
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

    expect(encrypt).toHaveBeenCalledTimes(3);
    expect(encrypt.mock.calls[2]?.[0]).toEqual(
      expect.objectContaining({
        plaintext: 'custom-client-secret',
        aad: expect.stringContaining('"credentialVersion":2'),
      })
    );
    expect(encrypt.mock.calls[2]?.[0].aad).toContain('"kind":"oauth-client-secret"');
    expect(credentialUpdates).toEqual([
      expect.objectContaining({
        access_token_encrypted: 'new-access-envelope',
        refresh_token_encrypted: 'new-refresh-envelope',
        oauth_client_secret_encrypted: 'new-client-secret-envelope',
        credential_version: 2,
      }),
    ]);
  });

  it('persists a refreshed credential after a single bounded token request', async () => {
    const input = refreshInput();
    const row = loadedRow(input);
    const state = installDatabase([row]);
    const crypto = new GitLabCredentialCrypto({});
    vi.spyOn(crypto, 'decrypt').mockResolvedValue({ status: 'available', token: 'refresh-token' });
    vi.spyOn(crypto, 'encrypt')
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-access-envelope' })
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-refresh-envelope' });
    const depthDuringCall: number[] = [];
    const fetchMock = vi.fn(async (_url: string, init?: RequestInit) => {
      depthDuringCall.push(state.depth);
      expect(init?.signal).toBeInstanceOf(AbortSignal);
      return refreshedTokenResponse();
    });

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
          fetch: fetchMock as unknown as typeof fetch,
        }
      ).refresh(input)
    ).resolves.toEqual({ status: 'available', token: 'new-access-token', credentialVersion: 2 });
    expect(depthDuringCall).toEqual([0]);
    expect(state.depth).toBe(0);
  });

  it('classifies an unanswered token request as temporary unavailability', async () => {
    const input = refreshInput();
    const row = loadedRow(input);
    const state = installDatabase([row]);
    const crypto = new GitLabCredentialCrypto({});
    vi.spyOn(crypto, 'decrypt').mockResolvedValue({ status: 'available', token: 'refresh-token' });
    vi.spyOn(AbortSignal, 'timeout').mockImplementation(() => {
      const controller = new AbortController();
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      return controller.signal;
    });
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      const { promise, reject } = Promise.withResolvers<Response>();
      const signal = init?.signal;
      if (!signal) {
        reject(new Error('missing signal'));
      } else if (signal.aborted) {
        reject(signal.reason);
      } else {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      }
      return promise;
    });

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
          fetch: fetchMock as unknown as typeof fetch,
        }
      ).refresh(input)
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    expect(state.credentialUpdates).toEqual([]);
    expect(state.integrationUpdates).toEqual([]);
    expect(state.depth).toBe(0);
  });

  it('returns the concurrent winner when another refresh commits first', async () => {
    const input = refreshInput();
    const candidate = loadedRow(input);
    const winner = loadedRow(input, {
      credential: {
        credential_version: 2,
        access_token_encrypted: 'winner-envelope',
        access_token_expires_at: '2026-07-13T13:00:00.000Z',
      },
    });
    const state = installDatabase([candidate, winner]);
    const crypto = new GitLabCredentialCrypto({});
    // The refresh token is only read once the exchange already owns the
    // credential, and here the winner's row replaces it before that.
    vi.spyOn(crypto, 'decrypt').mockResolvedValueOnce({
      status: 'available',
      token: 'winner-token',
    });

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
          fetch: vi.fn(async () => refreshedTokenResponse()) as unknown as typeof fetch,
        }
      ).refresh(input)
    ).resolves.toEqual({ status: 'available', token: 'winner-token', credentialVersion: 2 });
    expect(state.credentialUpdates).toEqual([]);
    expect(state.integrationUpdates).toEqual([]);
  });

  it('takes the lease only after re-reading the row it will exchange', async () => {
    // The claim can wait behind a holder that commits before releasing, so the
    // attempt must re-read the credential after it holds the lease: a row whose
    // version moved during the wait is answered from storage, never exchanged.
    const input = refreshInput();
    const candidate = loadedRow(input);
    const winner = loadedRow(input, {
      credential: {
        credential_version: 2,
        access_token_encrypted: 'winner-envelope',
        access_token_expires_at: '2026-07-13T13:00:00.000Z',
      },
    });
    const state = installDatabase([candidate, winner]);
    const crypto = new GitLabCredentialCrypto({});
    vi.spyOn(crypto, 'decrypt').mockResolvedValueOnce({
      status: 'available',
      token: 'winner-token',
    });
    const fetchMock = vi.fn();

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
          fetch: fetchMock as unknown as typeof fetch,
        }
      ).refresh(input)
    ).resolves.toEqual({ status: 'available', token: 'winner-token', credentialVersion: 2 });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(state.credentialUpdates).toEqual([]);
    expect(state.leases.size).toBe(0);
  });

  it('revokes the credential when the instance rejects the refresh token', async () => {
    const input = refreshInput();
    const row = loadedRow(input);
    const state = installDatabase([row]);
    const crypto = new GitLabCredentialCrypto({});
    vi.spyOn(crypto, 'decrypt').mockResolvedValue({ status: 'available', token: 'refresh-token' });

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
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify({ error: 'invalid_grant' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              })
          ) as unknown as typeof fetch,
        }
      ).refresh(input)
    ).resolves.toEqual({ status: 'reconnect_required' });
    expect(state.credentialUpdates).toEqual([
      expect.objectContaining({
        revoked_at: '2026-07-13T12:00:00.000Z',
        revocation_reason: 'refresh_token_rejected',
      }),
    ]);
  });

  it('keeps the credential usable when a refresh arrives while another attempt holds the lease', async () => {
    const input = refreshInput();
    const row = loadedRow(input);
    const state = installDatabase([row]);
    const crypto = new GitLabCredentialCrypto({});
    vi.spyOn(crypto, 'decrypt').mockResolvedValue({ status: 'available', token: 'refresh-token' });
    vi.spyOn(crypto, 'encrypt')
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-access-envelope' })
      .mockResolvedValueOnce({ status: 'available', ciphertext: 'new-refresh-envelope' });

    const stalled = Promise.withResolvers<Response>();
    let providerCalls = 0;
    const fetchMock = vi.fn(() => {
      providerCalls += 1;
      return stalled.promise;
    });
    const refresher = new GitLabOAuthCredentialRefresher(
      {
        HYPERDRIVE: { connectionString: 'postgres://test' } as Hyperdrive,
        GITLAB_CLIENT_ID: 'client-id',
        GITLAB_CLIENT_SECRET: 'client-secret',
      },
      {
        crypto,
        now: () => new Date('2026-07-13T12:00:00.000Z'),
        fetch: fetchMock as unknown as typeof fetch,
      }
    );

    const winner = refresher.refresh(input);
    await vi.waitFor(() => expect(providerCalls).toBe(1));

    await expect(refresher.refresh(input)).resolves.toEqual({ status: 'temporarily_unavailable' });
    expect(providerCalls).toBe(1);
    expect(state.credentialUpdates).toEqual([]);

    stalled.resolve(refreshedTokenResponse());
    await expect(winner).resolves.toEqual({
      status: 'available',
      token: 'new-access-token',
      credentialVersion: 2,
    });
    expect(state.credentialUpdates).toEqual([expect.objectContaining({ credential_version: 2 })]);
    expect(state.leases.size).toBe(0);
  });

  it('does not revoke when another attempt took over the exchange lease', async () => {
    const input = refreshInput();
    const row = loadedRow(input);
    const state = installDatabase([row]);
    state.releaseDenied = true;
    const crypto = new GitLabCredentialCrypto({});
    vi.spyOn(crypto, 'decrypt').mockResolvedValue({ status: 'available', token: 'refresh-token' });

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
          fetch: vi.fn(
            async () =>
              new Response(JSON.stringify({ error: 'invalid_grant' }), {
                status: 401,
                headers: { 'Content-Type': 'application/json' },
              })
          ) as unknown as typeof fetch,
        }
      ).refresh(input)
    ).resolves.toEqual({ status: 'temporarily_unavailable' });
    expect(state.credentialUpdates).toEqual([]);
  });
});
