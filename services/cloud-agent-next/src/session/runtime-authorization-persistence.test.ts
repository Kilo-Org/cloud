import { logger } from '../logger.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type {
  RuntimeAuthorization,
  RuntimeTokenDestination,
  RuntimeTokens,
} from '@kilocode/worker-utils/runtime-authorization-contract';
import {
  RuntimeAuthorizationExpiredError,
  RuntimeAuthorizationRevokedError,
} from '@kilocode/worker-utils/runtime-authorization';
import {
  getRuntimeAuthorizationStatus,
  inspectRuntimeAuthorizationRecoveryLock,
  runtimeAuthorizationRecoveryLockSchema,
  RUNTIME_AUTHORIZATION_RECOVERY_WARNING_MS,
  getRuntimeAuthorizationRecoveryState,
  renewStoredRuntimeAuthorization,
  runtimeTokenAudienceMode,
  runtimeTokenAuth,
  runtimeTokenFitsDestination,
} from './runtime-authorization-persistence.js';
import type { SessionMetadata } from '../persistence/session-metadata.js';

const authorization = (
  id: string,
  state: 'active' | 'revoked' = 'active'
): RuntimeAuthorization => ({
  version: 1,
  id,
  resourceKind: 'cloud-agent-next',
  resourceId: 'agent_1',
  userId: 'user_1',
  authorizationUserId: 'user_1',
  organizationId: 'org_1',
  issuedAt: '2026-01-01T00:00:00.000Z',
  delegationExpiresAt: '2026-01-02T00:00:00.000Z',
  state,
  bindings: {
    userPepperDigest: 'a'.repeat(64),
    authorizationPepperDigest: 'b'.repeat(64),
    userMembershipId: 'membership_1',
    authorizationUserMembershipId: 'membership_1',
  },
  source: { admissionSource: 'user' },
});

const metadata = (token?: string, runtimeTokens?: RuntimeTokens): SessionMetadata =>
  ({
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_1', userId: 'user_1', orgId: 'org_1' },
    auth: token ? { kilocodeToken: token, ...(runtimeTokens ? { runtimeTokens } : {}) } : {},
    agent: {},
    workspace: {},
    lifecycle: { version: 1, timestamp: 0 },
  }) as SessionMetadata;

/** One token value for every destination, the shape of a combined issuance. */
const sameTokens = (token: string): RuntimeTokens => ({
  'kilo-api': token,
  'kilo-gateway': token,
  'session-ingest': token,
});

const request = { audienceMode: 'per-destination', destination: 'kilo-api' } as const;

describe('runtime authorization persistence', () => {
  it('leaves legacy tokens unchanged and reports legacy without a private record', async () => {
    const stored = metadata('legacy-token');
    const token = await renewStoredRuntimeAuthorization({
      ...request,
      metadata: stored,
      getAuthorization: async () => undefined,
      putAuthorization: async () => {},
      getMetadata: async () => stored,
      putMetadata: async () => {},
      renew: async () => ({ tokens: sameTokens('renewed-token') }),
    });

    expect(token).toBe('legacy-token');
    await expect(
      getRuntimeAuthorizationStatus({ metadata: stored, getAuthorization: async () => undefined })
    ).resolves.toBe('legacy');
  });

  it('does not publish a renewal after a newer authorization replaces the record', async () => {
    let record: RuntimeAuthorization = authorization('00000000-0000-4000-8000-000000000001');
    const writes: SessionMetadata[] = [];
    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: metadata(),
        getAuthorization: async () => record,
        putAuthorization: async value => {
          record = value;
        },
        getMetadata: async () => metadata(),
        putMetadata: async value => {
          writes.push(value);
        },
        renew: async () => {
          record = authorization('00000000-0000-4000-8000-000000000002');
          return { tokens: sameTokens('new-token') };
        },
        now: Date.UTC(2026, 0, 1),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    expect(record.id).toBe('00000000-0000-4000-8000-000000000002');
    expect(writes).toEqual([]);
  });

  it('reuses a matching modern token outside the renewal window', async () => {
    const record = authorization('00000000-0000-4000-8000-000000000005');
    const now = Date.UTC(2026, 0, 1);
    const token = jwt.sign(
      {
        runtimeAuthorization: { id: record.id },
        aud: 'kilo-api',
        exp: Math.floor((now + 10 * 60_000) / 1000),
      },
      'test-secret',
      { noTimestamp: true }
    );
    const renew = vi.fn(async () => ({ tokens: sameTokens('unexpected') }));

    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: metadata(token),
        getAuthorization: async () => record,
        putAuthorization: async () => {},
        getMetadata: async () => metadata(token),
        putMetadata: async () => {},
        renew,
        now,
      })
    ).resolves.toBe(token);
    expect(renew).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'near expiry', expiresIn: 5 * 60_000 },
    { label: 'wrong authorization', expiresIn: 10 * 60_000, authorizationId: 'other' },
  ])('renews a modern token at $label', async ({ expiresIn, authorizationId }) => {
    const record = authorization('00000000-0000-4000-8000-000000000006');
    const now = Date.UTC(2026, 0, 1);
    const token = jwt.sign(
      {
        runtimeAuthorization: { id: authorizationId ?? record.id },
        aud: 'kilo-api',
        exp: Math.floor((now + expiresIn) / 1000),
      },
      'test-secret',
      { noTimestamp: true }
    );
    let stored = metadata(token);

    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: stored,
        getAuthorization: async () => record,
        putAuthorization: async () => {},
        getMetadata: async () => stored,
        putMetadata: async value => {
          stored = value;
        },
        renew: async () => ({ tokens: sameTokens('renewed-token') }),
        now,
      })
    ).resolves.toBe('renewed-token');
    expect(stored.auth.kilocodeToken).toBe('renewed-token');
  });

  it('rejects a revoked private authorization before renewal', async () => {
    const record = authorization('00000000-0000-4000-8000-000000000007', 'revoked');
    const renew = vi.fn(async () => ({ tokens: sameTokens('unexpected') }));

    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: metadata(),
        getAuthorization: async () => record,
        putAuthorization: async () => {},
        getMetadata: async () => metadata(),
        putMetadata: async () => {},
        renew,
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    expect(renew).not.toHaveBeenCalled();
  });

  it('marks only the matching revoked record and never renews it', async () => {
    let record = authorization('00000000-0000-4000-8000-000000000003');
    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: metadata(),
        getAuthorization: async () => record,
        putAuthorization: async value => {
          record = value;
        },
        getMetadata: async () => metadata(),
        putMetadata: async () => {},
        renew: async () => {
          throw new RuntimeAuthorizationRevokedError();
        },
        now: Date.UTC(2026, 0, 1),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    expect(record.state).toBe('revoked');
  });

  it('fails closed without revoking the current record at the delegation deadline', async () => {
    let record = {
      ...authorization('00000000-0000-4000-8000-000000000008'),
      delegationExpiresAt: '2026-01-02T00:00:00.000Z',
    };
    const renew = vi.fn(async () => ({ tokens: sameTokens('unexpected') }));

    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: metadata(),
        getAuthorization: async () => record,
        putAuthorization: async value => {
          record = value;
        },
        getMetadata: async () => metadata(),
        putMetadata: async () => {},
        renew,
        now: Date.UTC(2026, 0, 2),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationExpiredError);
    expect(record.state).toBe('active');
    expect(renew).not.toHaveBeenCalled();
  });

  it('keeps an active record recoverable when a background renewal observes expiration', async () => {
    let record = authorization('00000000-0000-4000-8000-000000000009');

    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: metadata(),
        getAuthorization: async () => record,
        putAuthorization: async value => {
          record = value;
        },
        getMetadata: async () => metadata(),
        putMetadata: async () => {},
        renew: async () => {
          throw new RuntimeAuthorizationExpiredError();
        },
        now: Date.UTC(2026, 0, 1),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationExpiredError);
    expect(record.state).toBe('active');
  });

  it('distinguishes natural expiry from explicit revocation for foreground recovery', async () => {
    const expired = authorization('00000000-0000-4000-8000-000000000010');
    await expect(
      getRuntimeAuthorizationRecoveryState({
        metadata: metadata(),
        getAuthorization: async () => expired,
        now: Date.UTC(2026, 0, 2),
      })
    ).resolves.toEqual({ state: 'expired', id: expired.id });
    await expect(
      getRuntimeAuthorizationRecoveryState({
        metadata: metadata(),
        getAuthorization: async () => ({ ...expired, state: 'revoked' }),
        now: Date.UTC(2026, 0, 2),
      })
    ).resolves.toEqual({ state: 'revoked' });
  });

  it('treats modern-token metadata without a valid private record as revoked', async () => {
    const token = jwt.sign(
      { runtimeAuthorization: { id: '00000000-0000-4000-8000-000000000004' } },
      'test-secret'
    );
    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: metadata(token),
        getAuthorization: async () => undefined,
        putAuthorization: async () => {},
        getMetadata: async () => metadata(token),
        putMetadata: async () => {},
        renew: async () => ({ tokens: sameTokens('unexpected') }),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
  });
});

describe('per-destination runtime tokens', () => {
  const record = authorization('00000000-0000-4000-8000-000000000020');
  const now = Date.UTC(2026, 0, 1);
  const destinations = ['kilo-api', 'kilo-gateway', 'session-ingest'] as const;
  const combinedAudience = [...destinations];
  // A token at 30 minutes is within its normal validity; one at 4 minutes is due for renewal.
  const signed = (aud: string | string[] | undefined, expiresInMs = 30 * 60_000) =>
    jwt.sign(
      {
        runtimeAuthorization: { id: record.id },
        ...(aud === undefined ? {} : { aud }),
        exp: Math.floor((now + expiresInMs) / 1000),
      },
      'test-secret',
      { noTimestamp: true }
    );
  const dueMs = 4 * 60_000;
  const perDestinationTokens = (): RuntimeTokens => ({
    'kilo-api': signed('kilo-api'),
    'kilo-gateway': signed('kilo-gateway'),
    'session-ingest': signed('session-ingest'),
  });

  async function serve(input: {
    stored: SessionMetadata;
    audienceMode: 'combined' | 'per-destination';
    destination: RuntimeTokenDestination | undefined;
    renewed?: RuntimeTokens;
  }) {
    let stored = input.stored;
    const renew = vi.fn(async () => ({ tokens: input.renewed ?? perDestinationTokens() }));
    const token = await renewStoredRuntimeAuthorization({
      metadata: stored,
      audienceMode: input.audienceMode,
      destination: input.destination,
      getAuthorization: async () => record,
      putAuthorization: async () => {},
      getMetadata: async () => stored,
      putMetadata: async value => {
        stored = value;
      },
      renew,
      now,
    });
    return { token, renew, stored };
  }

  it('serves each destination only its own stored token', async () => {
    const tokens = perDestinationTokens();
    for (const destination of destinations) {
      const result = await serve({
        stored: metadata(tokens['kilo-api'], tokens),
        audienceMode: 'per-destination',
        destination,
      });
      expect(result.token).toBe(tokens[destination]);
      expect(result.renew).not.toHaveBeenCalled();
      expect(runtimeTokenFitsDestination(tokens[destination], destination)).toBe(true);
      for (const other of destinations.filter(value => value !== destination)) {
        expect(runtimeTokenFitsDestination(tokens[destination], other)).toBe(false);
      }
    }
  });

  it('does not renew early on a flip in either direction', async () => {
    const combined = signed(combinedAudience);
    const tokens = perDestinationTokens();
    for (const destination of destinations) {
      const toSplit = await serve({
        stored: metadata(combined),
        audienceMode: 'per-destination',
        destination,
      });
      expect(toSplit.token).toBe(combined);
      expect(toSplit.renew).not.toHaveBeenCalled();
      const toCombined = await serve({
        stored: metadata(tokens['kilo-api'], tokens),
        audienceMode: 'combined',
        destination,
      });
      expect(toCombined.token).toBe(tokens[destination]);
      expect(toCombined.renew).not.toHaveBeenCalled();
    }
  });

  it('switches a stored combined token to per-destination tokens at its due renewal', async () => {
    const renewed = perDestinationTokens();
    const result = await serve({
      stored: metadata(signed(combinedAudience, dueMs)),
      audienceMode: 'per-destination',
      destination: 'kilo-gateway',
      renewed,
    });
    expect(result.renew).toHaveBeenCalledTimes(1);
    expect(result.token).toBe(renewed['kilo-gateway']);
    expect(result.stored.auth).toEqual({
      kilocodeToken: renewed['kilo-api'],
      runtimeTokens: renewed,
    });
  });

  it('switches stored per-destination tokens back to the combined layout at their due renewal', async () => {
    const tokens: RuntimeTokens = {
      'kilo-api': signed('kilo-api', dueMs),
      'kilo-gateway': signed('kilo-gateway', dueMs),
      'session-ingest': signed('session-ingest', dueMs),
    };
    const combined = signed(combinedAudience);
    const result = await serve({
      stored: metadata(tokens['kilo-api'], tokens),
      audienceMode: 'combined',
      destination: 'session-ingest',
      renewed: sameTokens(combined),
    });
    expect(result.renew).toHaveBeenCalledTimes(1);
    expect(result.token).toBe(combined);
    expect(result.stored.auth).toEqual({ kilocodeToken: combined });
  });

  it.each([
    ['another destination', 'kilo-api'],
    ['a subset', ['kilo-api', 'kilo-gateway']],
    ['a reordered claim', ['kilo-gateway', 'kilo-api', 'session-ingest']],
    ['no audience', undefined],
  ])('renews instead of serving a stored token with %s', async (_label, aud) => {
    for (const audienceMode of ['combined', 'per-destination'] as const) {
      const tokens = { ...perDestinationTokens(), 'kilo-gateway': signed(aud) };
      const renewed = perDestinationTokens();
      const result = await serve({
        stored: metadata(tokens['kilo-api'], tokens),
        audienceMode,
        destination: 'kilo-gateway',
        renewed,
      });
      expect(result.renew).toHaveBeenCalledTimes(1);
      expect(result.token).toBe(renewed['kilo-gateway']);
    }
  });

  it('serves a caller without a destination only the exact combined token', async () => {
    const combined = signed(combinedAudience);
    for (const audienceMode of ['combined', 'per-destination'] as const) {
      const result = await serve({
        stored: metadata(combined),
        audienceMode,
        destination: undefined,
      });
      expect(result.token).toBe(combined);
      expect(result.renew).not.toHaveBeenCalled();
    }
    const tokens = perDestinationTokens();
    await expect(
      serve({
        stored: metadata(tokens['kilo-api'], tokens),
        audienceMode: 'per-destination',
        destination: undefined,
      })
    ).rejects.toThrow('Runtime token destination required');
    const renewed = await serve({
      stored: metadata(tokens['kilo-api'], tokens),
      audienceMode: 'combined',
      destination: undefined,
      renewed: sameTokens(combined),
    });
    expect(renewed.renew).toHaveBeenCalledTimes(1);
    expect(renewed.token).toBe(combined);
  });

  it('stores a combined issuance in the earlier single-token layout', () => {
    expect(runtimeTokenAuth(sameTokens('combined'))).toEqual({
      kilocodeToken: 'combined',
      runtimeTokens: undefined,
    });
    const tokens = perDestinationTokens();
    expect(runtimeTokenAuth(tokens)).toEqual({
      kilocodeToken: tokens['kilo-api'],
      runtimeTokens: tokens,
    });
  });

  it('lets the proxy send a token only where its audience can be accepted', () => {
    const combined = signed(combinedAudience);
    for (const destination of destinations) {
      expect(runtimeTokenFitsDestination(combined, destination)).toBe(true);
    }
    expect(runtimeTokenFitsDestination(signed('cloud-agent-next'), 'kilo-api')).toBe(false);
    expect(runtimeTokenFitsDestination(signed(['kilo-gateway']), 'kilo-api')).toBe(false);
    // No readable audience: the destination's own verifier decides, as before.
    expect(runtimeTokenFitsDestination(signed(undefined), 'kilo-api')).toBe(true);
    expect(runtimeTokenFitsDestination('not-a-jwt', 'kilo-api')).toBe(true);
  });

  it('reads the rollout switch from the Worker environment', () => {
    expect(runtimeTokenAudienceMode({})).toBe('combined');
    expect(runtimeTokenAudienceMode({ RUNTIME_TOKEN_AUDIENCE_MODE: 'combined' })).toBe('combined');
    expect(runtimeTokenAudienceMode({ RUNTIME_TOKEN_AUDIENCE_MODE: 'per-destination' })).toBe(
      'per-destination'
    );
    for (const value of ['PER-DESTINATION', '', true]) {
      expect(() => runtimeTokenAudienceMode({ RUNTIME_TOKEN_AUDIENCE_MODE: value })).toThrow();
    }
  });
});

describe('recovery lock diagnostics', () => {
  const lock = {
    expectedOldId: '00000000-0000-4000-8000-000000000001',
    recoveryId: '00000000-0000-4000-8000-000000000002',
  };
  const start = 1_000;
  const threshold = RUNTIME_AUTHORIZATION_RECOVERY_WARNING_MS;

  it('starts aging legacy locks without modifying their strict two-field contract', () => {
    const original = { ...lock };
    const first = inspectRuntimeAuthorizationRecoveryLock(lock, undefined, start);
    expect(first).toEqual({
      diagnostics: { ...lock, startedAt: start },
      changed: true,
      warn: false,
    });
    expect(lock).toEqual(original);
    expect(runtimeAuthorizationRecoveryLockSchema.parse(lock)).toEqual(original);
  });

  it('preserves the durable start and warning cadence across repeated inspections', () => {
    const first = inspectRuntimeAuthorizationRecoveryLock(lock, undefined, start);
    const early = inspectRuntimeAuthorizationRecoveryLock(
      lock,
      first.diagnostics,
      start + threshold - 1
    );
    expect(early.changed).toBe(false);
    expect(early.warn).toBe(false);
    const warning = inspectRuntimeAuthorizationRecoveryLock(
      lock,
      early.diagnostics,
      start + threshold
    );
    expect(warning.warn).toBe(true);
    // Round-trip storage as on a new DO instance; warnings are not an in-memory timer.
    const stored = JSON.parse(JSON.stringify(warning.diagnostics));
    expect(
      inspectRuntimeAuthorizationRecoveryLock(lock, stored, start + 2 * threshold - 1).warn
    ).toBe(false);
    const next = inspectRuntimeAuthorizationRecoveryLock(lock, stored, start + 2 * threshold);
    expect(next.warn).toBe(true);
    expect(next.diagnostics.startedAt).toBe(start);
    expect(lock).toEqual({ expectedOldId: lock.expectedOldId, recoveryId: lock.recoveryId });
  });

  it.each([
    undefined,
    { ...lock, startedAt: 'invalid' },
    { ...lock, recoveryId: '00000000-0000-4000-8000-000000000003', startedAt: 0 },
    { ...lock, expectedOldId: '00000000-0000-4000-8000-000000000003', startedAt: 0 },
  ])(
    'does not inherit age from missing, malformed or differently bound diagnostics: %j',
    diagnostics => {
      expect(inspectRuntimeAuthorizationRecoveryLock(lock, diagnostics, start + threshold)).toEqual(
        {
          diagnostics: { ...lock, startedAt: start + threshold },
          changed: true,
          warn: false,
        }
      );
    }
  );
});

describe('runtime authorization diagnostics', () => {
  afterEach(() => vi.restoreAllMocks());
  it('still persists revocation and preserves the error when logging throws', async () => {
    vi.spyOn(logger, 'withFields').mockImplementation(() => {
      throw new Error('private-logger-error');
    });
    const record = authorization('00000000-0000-4000-8000-000000000011');
    const putAuthorization = vi.fn();
    const error = new RuntimeAuthorizationRevokedError();
    await expect(
      renewStoredRuntimeAuthorization({
        ...request,
        metadata: metadata('private-token'),
        getAuthorization: async () => record,
        putAuthorization,
        getMetadata: async () => metadata(),
        putMetadata: async () => {},
        renew: async () => {
          throw error;
        },
        now: Date.UTC(2026, 0, 1),
      })
    ).rejects.toBe(error);
    expect(putAuthorization).toHaveBeenCalledWith({ ...record, state: 'revoked' });
  });

  it.each(['revoked', 'expired', 'transient', 'metadata_changed'] as const)(
    'reports %s without exposing renewal secrets and preserves storage behavior',
    async kind => {
      const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
      vi.spyOn(logger, 'warn').mockImplementation(() => {});
      let record = authorization('00000000-0000-4000-8000-000000000011');
      const stored = metadata('private-token');
      const error =
        kind === 'revoked'
          ? new RuntimeAuthorizationRevokedError()
          : kind === 'expired'
            ? new RuntimeAuthorizationExpiredError()
            : new Error('private-error');
      await expect(
        renewStoredRuntimeAuthorization({
          ...request,
          metadata: stored,
          getAuthorization: async () => record,
          putAuthorization: async value => {
            record = value;
          },
          getMetadata: async () => (kind === 'metadata_changed' ? null : stored),
          putMetadata: async () => {},
          renew: async () => {
            if (kind === 'metadata_changed') return { tokens: sameTokens('private-renewed-token') };
            throw error;
          },
          now: Date.UTC(2026, 0, 1),
        })
      ).rejects.toThrow(
        kind === 'metadata_changed' ? 'Runtime authorization has been revoked' : error.message
      );
      const reason = {
        revoked: 'renewal_revoked',
        expired: 'delegation_expired',
        transient: 'renewal_failed',
        metadata_changed: 'post_renewal_state_changed',
      }[kind];
      const revoked = kind === 'revoked' || kind === 'metadata_changed';
      expect(fields.mock.calls).toEqual([
        [{ sessionId: 'agent_1', stage: 'renewal', reason }],
        ...(revoked
          ? [[{ sessionId: 'agent_1', stage: 'renewal', reason: 'revocation_persisted' }]]
          : []),
      ]);
      expect(record.state).toBe(revoked ? 'revoked' : 'active');
      expect(JSON.stringify(fields.mock.calls)).not.toContain('private-');
      expect(JSON.stringify(fields.mock.calls)).not.toContain(record.bindings.userPepperDigest);
    }
  );
  it.each(['invalid', 'revoked'] as const)('distinguishes %s stored recovery state', async kind => {
    const fields = vi.spyOn(logger, 'withFields').mockReturnValue(logger);
    vi.spyOn(logger, 'warn').mockImplementation(() => {});
    const token = jwt.sign({ runtimeAuthorization: { id: 'private-claim' } }, 'private-secret');
    await expect(
      getRuntimeAuthorizationRecoveryState({
        metadata: metadata(token),
        getAuthorization: async () =>
          kind === 'invalid'
            ? { private: 'private-record' }
            : authorization('00000000-0000-4000-8000-000000000011', 'revoked'),
      })
    ).resolves.toEqual({ state: 'revoked' });
    expect(fields.mock.calls).toEqual([
      [{ sessionId: 'agent_1', stage: 'recovery_state', reason: `stored_authorization_${kind}` }],
    ]);
  });
});
