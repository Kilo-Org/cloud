import { describe, expect, it, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import type { RuntimeAuthorization } from '@kilocode/worker-utils/runtime-authorization-contract';
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

const metadata = (token?: string): SessionMetadata =>
  ({
    metadataSchemaVersion: 2,
    identity: { sessionId: 'agent_1', userId: 'user_1', orgId: 'org_1' },
    auth: token ? { kilocodeToken: token } : {},
    agent: {},
    workspace: {},
    lifecycle: { version: 1, timestamp: 0 },
  }) as SessionMetadata;

describe('runtime authorization persistence', () => {
  it('leaves legacy tokens unchanged and reports legacy without a private record', async () => {
    const stored = metadata('legacy-token');
    const token = await renewStoredRuntimeAuthorization({
      metadata: stored,
      getAuthorization: async () => undefined,
      putAuthorization: async () => {},
      getMetadata: async () => stored,
      putMetadata: async () => {},
      renew: async () => ({ token: 'renewed-token' }),
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
          return { token: 'new-token' };
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
        exp: Math.floor((now + 10 * 60_000) / 1000),
      },
      'test-secret',
      { noTimestamp: true }
    );
    const renew = vi.fn(async () => ({ token: 'unexpected' }));

    await expect(
      renewStoredRuntimeAuthorization({
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
        exp: Math.floor((now + expiresIn) / 1000),
      },
      'test-secret',
      { noTimestamp: true }
    );
    let stored = metadata(token);

    await expect(
      renewStoredRuntimeAuthorization({
        metadata: stored,
        getAuthorization: async () => record,
        putAuthorization: async () => {},
        getMetadata: async () => stored,
        putMetadata: async value => {
          stored = value;
        },
        renew: async () => ({ token: 'renewed-token' }),
        now,
      })
    ).resolves.toBe('renewed-token');
    expect(stored.auth.kilocodeToken).toBe('renewed-token');
  });

  it('rejects a revoked private authorization before renewal', async () => {
    const record = authorization('00000000-0000-4000-8000-000000000007', 'revoked');
    const renew = vi.fn(async () => ({ token: 'unexpected' }));

    await expect(
      renewStoredRuntimeAuthorization({
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
    const renew = vi.fn(async () => ({ token: 'unexpected' }));

    await expect(
      renewStoredRuntimeAuthorization({
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
        metadata: metadata(token),
        getAuthorization: async () => undefined,
        putAuthorization: async () => {},
        getMetadata: async () => metadata(token),
        putMetadata: async () => {},
        renew: async () => ({ token: 'unexpected' }),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
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
