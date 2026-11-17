import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from 'jose';
import { signModernKiloToken } from './kilo-token-policy.js';
import {
  createRuntimeAuthorization,
  renewRuntimeAuthorization,
  sealRuntimeAuthorization,
  unsealRuntimeAuthorization,
  RuntimeAuthorizationExpiredError,
  RuntimeAuthorizationRevokedError,
  RuntimeAuthorizationSchema,
} from './runtime-authorization.js';
import type {
  RuntimeAuthorizationAdapters,
  RuntimeAuthorizationPrincipal,
} from './runtime-authorization.js';

const secret = 'runtime-authorization-test-secret-at-least-32';
const principals = new Map<string, RuntimeAuthorizationPrincipal>([
  [
    'user',
    {
      id: 'user',
      apiTokenPepper: 'user-pepper',
      blockedAt: null,
      blockedReason: null,
      isBot: false,
    },
  ],
  [
    'bot',
    { id: 'bot', apiTokenPepper: 'bot-pepper', blockedAt: null, blockedReason: null, isBot: true },
  ],
]);
const memberships = new Map([
  ['org:user', { id: 'membership-user', role: 'admin', organizationDeletedAt: null }],
  ['org:bot', { id: 'membership-bot', role: 'member', organizationDeletedAt: null }],
]);
/** Live device sessions, keyed by `<device session>:<user>`. */
const liveDeviceSessions = new Set<string>();

function adapters(): RuntimeAuthorizationAdapters {
  return {
    getPrincipal: vi.fn(async ({ userId }) => principals.get(userId) ?? null),
    getMembership: vi.fn(
      async ({ organizationId, userId }) => memberships.get(`${organizationId}:${userId}`) ?? null
    ),
    isDeviceSessionActive: vi.fn(async ({ deviceSessionId, userId }) =>
      liveDeviceSessions.has(`${deviceSessionId}:${userId}`)
    ),
  };
}

async function admission(
  options: {
    userId?: string;
    source?: 'user' | 'automation';
    audience?: string | string[];
    expiresInSeconds?: number;
    deviceSessionId?: string;
  } = {}
) {
  const source = options.source ?? 'user';
  const userId = options.userId ?? 'user';
  return signModernKiloToken({
    userId,
    pepper: principals.get(userId)?.apiTokenPepper ?? null,
    secret,
    expiresInSeconds: options.expiresInSeconds ?? 300,
    audience: options.audience ?? 'cloud-agent-next',
    tokenPurpose:
      source === 'user'
        ? options.deviceSessionId === undefined
          ? 'human-api'
          : 'device-access'
        : 'internal-service',
    credentialExchange: false,
    extra: {
      organizationId: 'org',
      ...(options.deviceSessionId === undefined
        ? {}
        : { deviceSessionId: options.deviceSessionId }),
      runtimeAdmission: {
        source,
        authorizationUserId: 'user',
        authorizationPepper: 'user-pepper',
      },
    },
  });
}

describe('runtime authorization', () => {
  beforeEach(() => {
    principals.set('user', {
      id: 'user',
      apiTokenPepper: 'user-pepper',
      blockedAt: null,
      blockedReason: null,
      isBot: false,
    });
    principals.set('bot', {
      id: 'bot',
      apiTokenPepper: 'bot-pepper',
      blockedAt: null,
      blockedReason: null,
      isBot: true,
    });
    memberships.set('org:user', {
      id: 'membership-user',
      role: 'admin',
      organizationDeletedAt: null,
    });
    memberships.set('org:bot', {
      id: 'membership-bot',
      role: 'member',
      organizationDeletedAt: null,
    });
    liveDeviceSessions.clear();
  });
  afterEach(() => vi.useRealTimers());
  it('creates a bound authorization and issues a runtime-only audience token', async () => {
    const control = await admission();
    const result = await createRuntimeAuthorization({
      token: control.token,
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    });

    expect(result.authorization.bindings.userPepperDigest).not.toContain('user-pepper');
    expect(decodeJwt(result.token)).toMatchObject({
      aud: ['kilo-api', 'kilo-gateway', 'session-ingest'],
      tokenPurpose: 'delegated-workload',
      credentialExchange: false,
      runtimeAuthorization: { id: result.authorization.id, resourceId: 'session' },
    });
  });

  it.each([
    { userId: 'user', rotatedUserId: 'user' },
    { userId: 'bot', rotatedUserId: 'bot' },
    { userId: 'bot', rotatedUserId: 'user' },
  ])(
    'preserves explicit null automation peppers for $userId and revokes after $rotatedUserId rotates',
    async ({ userId, rotatedUserId }) => {
      for (const id of ['user', 'bot']) {
        principals.set(id, {
          id,
          apiTokenPepper: null,
          blockedAt: null,
          blockedReason: null,
          isBot: id === 'bot',
        });
      }
      const control = await signModernKiloToken({
        userId,
        pepper: null,
        secret,
        expiresInSeconds: 300,
        audience: 'cloud-agent-next',
        tokenPurpose: 'internal-service',
        credentialExchange: false,
        extra: {
          organizationId: 'org',
          runtimeAdmission: {
            source: 'automation',
            authorizationUserId: 'user',
            authorizationPepper: null,
          },
        },
      });
      expect(decodeJwt(control.token)).toMatchObject({
        apiTokenPepper: null,
        tokenPurpose: 'internal-service',
        runtimeAdmission: { source: 'automation', authorizationPepper: null },
      });
      const common = {
        secret,
        connectionString: 'postgres://unused',
        adapters: adapters(),
      };
      const creation = {
        ...common,
        token: control.token,
        resourceKind: 'cloud-agent-next' as const,
        resourceId: 'session',
        organizationId: 'org',
      };
      const created = await createRuntimeAuthorization(creation);
      expect(created.authorization).toMatchObject({
        userId,
        authorizationUserId: 'user',
        bindings: { userPepperDigest: 'null', authorizationPepperDigest: 'null' },
        source: { admissionSource: 'automation' },
      });
      const persisted = await unsealRuntimeAuthorization(
        await sealRuntimeAuthorization(created.authorization, secret),
        secret,
        { resourceKind: 'cloud-agent-next', resourceId: 'session', userId, organizationId: 'org' }
      );
      expect(persisted).toEqual(created.authorization);
      const renewed = await renewRuntimeAuthorization({ ...common, authorization: persisted });
      for (const token of [created.token, renewed.token]) {
        expect(decodeJwt(token)).toMatchObject({
          apiTokenPepper: null,
          tokenPurpose: 'delegated-workload',
          runtimeAuthorization: { id: persisted.id, resourceId: 'session' },
        });
      }

      principals.set(rotatedUserId, {
        id: rotatedUserId,
        apiTokenPepper: 'rotated-pepper',
        blockedAt: null,
        blockedReason: null,
        isBot: rotatedUserId === 'bot',
      });
      await expect(createRuntimeAuthorization(creation)).rejects.toThrow(
        'Invalid runtime admission'
      );
      await expect(
        renewRuntimeAuthorization({ ...common, authorization: persisted })
      ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    }
  );

  it('sets a fixed delegation deadline independently of control expiry', async () => {
    vi.useFakeTimers();
    const now = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(now);
    const cloudAgent = await createRuntimeAuthorization({
      token: (await admission({ expiresInSeconds: 60 })).token,
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
      now,
    });

    expect(cloudAgent.authorization.delegationExpiresAt).toBe('2026-01-02T00:00:00.000Z');
    expect(decodeJwt(cloudAgent.token).exp).toBe(Date.UTC(2026, 0, 1, 1) / 1000);
  });

  it('caps runtime-token expiration to the positive duration remaining before the deadline', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-01-01T00:00:00.000Z'));
    const created = await createRuntimeAuthorization({
      token: (await admission()).token,
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    });
    const renewalTime = new Date('2026-01-01T23:40:00.000Z');
    vi.setSystemTime(renewalTime);

    const renewed = await renewRuntimeAuthorization({
      authorization: created.authorization,
      secret,
      connectionString: 'postgres://unused',
      adapters: adapters(),
      now: renewalTime,
    });

    expect(decodeJwt(renewed.token).exp).toBe(Date.UTC(2026, 0, 2) / 1000);
    expect(renewed.expiresAt).toBe('2026-01-02T00:00:00.000Z');
  });

  it('rejects renewal at and after the fixed delegation deadline', async () => {
    vi.useFakeTimers();
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    vi.setSystemTime(createdAt);
    const created = await createRuntimeAuthorization({
      token: (await admission()).token,
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
      now: createdAt,
    });
    const deadline = new Date(created.authorization.delegationExpiresAt);

    await expect(
      renewRuntimeAuthorization({
        authorization: created.authorization,
        secret,
        connectionString: 'postgres://unused',
        adapters: adapters(),
        now: deadline,
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationExpiredError);
    await expect(
      renewRuntimeAuthorization({
        authorization: created.authorization,
        secret,
        connectionString: 'postgres://unused',
        adapters: adapters(),
        now: new Date(deadline.getTime() + 1),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationExpiredError);
  });

  it('rejects normal, multi-audience, expired, and mismatched control tokens', async () => {
    const valid = await admission();
    const common = {
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'cloud-agent-next' as const,
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    };
    await expect(
      createRuntimeAuthorization({ ...common, token: valid.token.replace(/[^.]+$/, 'tampered') })
    ).rejects.toThrow();
    await expect(
      createRuntimeAuthorization({
        ...common,
        token: (await admission({ audience: ['cloud-agent-next', 'kilo-api'] })).token,
      })
    ).rejects.toThrow();
    const ordinary = await signModernKiloToken({
      userId: 'user',
      pepper: 'user-pepper',
      secret,
      expiresInSeconds: 300,
      audience: 'cloud-agent-next',
      tokenPurpose: 'human-api',
      credentialExchange: false,
    });
    await expect(
      createRuntimeAuthorization({ ...common, token: ordinary.token })
    ).rejects.toThrow();
    await expect(
      createRuntimeAuthorization({
        ...common,
        token: (await admission({ audience: 'kilo-gateway' })).token,
      })
    ).rejects.toThrow();
    const expiring = await admission({ expiresInSeconds: 60 });
    vi.setSystemTime(new Date(Date.now() + 61_000));
    await expect(
      createRuntimeAuthorization({ ...common, token: expiring.token })
    ).rejects.toThrow();
  });

  it('binds renewals to current peppers, blocks, and membership identities', async () => {
    const result = await createRuntimeAuthorization({
      token: (await admission({ userId: 'bot', source: 'automation' })).token,
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    });
    principals.set('bot', {
      id: 'bot',
      apiTokenPepper: 'rotated',
      blockedAt: null,
      blockedReason: null,
      isBot: true,
    });
    await expect(
      renewRuntimeAuthorization({
        authorization: result.authorization,
        secret,
        connectionString: 'postgres://unused',
        adapters: adapters(),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    principals.set('bot', {
      id: 'bot',
      apiTokenPepper: 'bot-pepper',
      blockedAt: null,
      blockedReason: null,
      isBot: true,
    });
    memberships.set('org:bot', {
      id: 're-added-membership',
      role: 'member',
      organizationDeletedAt: null,
    });
    await expect(
      renewRuntimeAuthorization({
        authorization: result.authorization,
        secret,
        connectionString: 'postgres://unused',
        adapters: adapters(),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
  });

  it('binds a device-access delegation to its session and renews only while it is live', async () => {
    const deviceSessionId = crypto.randomUUID();
    liveDeviceSessions.add(`${deviceSessionId}:user`);
    const common = { secret, connectionString: 'postgres://unused' };
    const created = await createRuntimeAuthorization({
      ...common,
      token: (await admission({ deviceSessionId })).token,
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    });

    expect(created.authorization.bindings.deviceSessionId).toBe(deviceSessionId);
    await expect(
      renewRuntimeAuthorization({
        ...common,
        authorization: created.authorization,
        adapters: adapters(),
      })
    ).resolves.toMatchObject({ expiresAt: expect.any(String) });

    liveDeviceSessions.delete(`${deviceSessionId}:user`);
    const onBindingRejected = vi.fn();
    await expect(
      renewRuntimeAuthorization({
        ...common,
        authorization: created.authorization,
        adapters: adapters(),
        onBindingRejected,
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
    expect(onBindingRejected.mock.calls).toEqual([['device_session_inactive']]);
  });

  it('records the session only while the session belongs to the admitted user', async () => {
    const deviceSessionId = crypto.randomUUID();
    liveDeviceSessions.add(`${deviceSessionId}:bot`);
    const common = { secret, connectionString: 'postgres://unused' };

    await expect(
      createRuntimeAuthorization({
        ...common,
        token: (await admission({ deviceSessionId })).token,
        resourceKind: 'cloud-agent-next',
        resourceId: 'session',
        organizationId: 'org',
        adapters: adapters(),
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
  });

  it('refuses a device-access admission that names no device session', async () => {
    const control = await signModernKiloToken({
      userId: 'user',
      pepper: 'user-pepper',
      secret,
      expiresInSeconds: 300,
      audience: 'cloud-agent-next',
      tokenPurpose: 'device-access',
      credentialExchange: false,
      extra: {
        organizationId: 'org',
        runtimeAdmission: {
          source: 'user',
          authorizationUserId: 'user',
          authorizationPepper: 'user-pepper',
        },
      },
    });

    await expect(
      createRuntimeAuthorization({
        token: control.token,
        secret,
        connectionString: 'postgres://unused',
        resourceKind: 'cloud-agent-next',
        resourceId: 'session',
        organizationId: 'org',
        adapters: adapters(),
      })
    ).rejects.toThrow('Invalid runtime admission');
  });

  it('leaves a human-api delegation unbound and renewable without any device session', async () => {
    const common = { secret, connectionString: 'postgres://unused' };
    const created = await createRuntimeAuthorization({
      ...common,
      token: (await admission()).token,
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    });

    expect(created.authorization.bindings).not.toHaveProperty('deviceSessionId');
    await expect(
      renewRuntimeAuthorization({
        ...common,
        authorization: created.authorization,
        adapters: adapters(),
      })
    ).resolves.toMatchObject({ expiresAt: expect.any(String) });
  });

  it('keeps a stored record without a device session binding on its own lifetime', async () => {
    const deviceSessionId = crypto.randomUUID();
    liveDeviceSessions.add(`${deviceSessionId}:user`);
    const common = { secret, connectionString: 'postgres://unused' };
    const created = await createRuntimeAuthorization({
      ...common,
      token: (await admission({ deviceSessionId })).token,
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    });
    const { deviceSessionId: _recorded, ...legacyBindings } = created.authorization.bindings;
    const legacy = RuntimeAuthorizationSchema.parse({
      ...created.authorization,
      bindings: legacyBindings,
    });

    liveDeviceSessions.clear();
    await expect(
      renewRuntimeAuthorization({ ...common, authorization: legacy, adapters: adapters() })
    ).resolves.toMatchObject({ expiresAt: expect.any(String) });
  });

  it.each([
    'principal_missing',
    'principal_blocked',
    'pepper_changed',
    'membership_missing',
    'organization_deleted',
    'membership_role_invalid',
    'membership_changed',
    'device_session_inactive',
  ] as const)('reports only the fixed binding reason %s', async reason => {
    const deviceSessionId = crypto.randomUUID();
    liveDeviceSessions.add(`${deviceSessionId}:user`);
    const result = await createRuntimeAuthorization({
      token: (await admission({ deviceSessionId })).token,
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    });
    const onBindingRejected = vi.fn();
    const failingAdapters: RuntimeAuthorizationAdapters = {
      isDeviceSessionActive: async () => reason !== 'device_session_inactive',
      getPrincipal: async () =>
        reason === 'principal_missing'
          ? null
          : {
              id: 'user',
              apiTokenPepper: reason === 'pepper_changed' ? 'private-new-pepper' : 'user-pepper',
              blockedAt: null,
              blockedReason: reason === 'principal_blocked' ? 'private-block-reason' : null,
              isBot: false,
            },
      getMembership: async () =>
        reason === 'membership_missing'
          ? null
          : {
              id: reason === 'membership_changed' ? 'private-new-membership' : 'membership-user',
              role: reason === 'membership_role_invalid' ? 'private-role' : 'admin',
              organizationDeletedAt: reason === 'organization_deleted' ? '2026-01-01' : null,
            },
    };
    await expect(
      renewRuntimeAuthorization({
        authorization: result.authorization,
        secret,
        connectionString: 'postgres://unused',
        adapters: failingAdapters,
        onBindingRejected,
      })
    ).rejects.toMatchObject({
      name: 'RuntimeAuthorizationRevokedError',
      message: 'Runtime authorization has been revoked',
    });
    expect(onBindingRejected.mock.calls).toEqual([[reason]]);
    await expect(
      renewRuntimeAuthorization({
        authorization: result.authorization,
        secret,
        connectionString: 'postgres://unused',
        adapters: failingAdapters,
        onBindingRejected: () => {
          throw new Error('private-logger-error');
        },
      })
    ).rejects.toBeInstanceOf(RuntimeAuthorizationRevokedError);
  });

  it('seals only the exact intended runtime record', async () => {
    const result = await createRuntimeAuthorization({
      token: (await admission()).token,
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'cloud-agent-next',
      resourceId: 'session',
      organizationId: 'org',
      adapters: adapters(),
    });
    const sealed = await sealRuntimeAuthorization(result.authorization, secret);
    await expect(
      unsealRuntimeAuthorization(sealed, secret, {
        resourceKind: 'cloud-agent-next',
        resourceId: 'session',
        userId: 'user',
        organizationId: 'org',
      })
    ).resolves.toEqual(result.authorization);
    await expect(
      unsealRuntimeAuthorization(sealed, secret, {
        resourceKind: 'cloud-agent-next',
        resourceId: 'other',
        userId: 'user',
        organizationId: 'org',
      })
    ).rejects.toThrow();
    await expect(
      unsealRuntimeAuthorization(`${sealed}x`, secret, {
        resourceKind: 'cloud-agent-next',
        resourceId: 'session',
        userId: 'user',
        organizationId: 'org',
      })
    ).rejects.toThrow();
  });
});
