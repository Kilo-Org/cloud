import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { decodeJwt } from 'jose';
import { signModernKiloToken } from './kilo-token-policy.js';
import {
  createRuntimeAuthorization,
  renewRuntimeAuthorization,
  sealRuntimeAuthorization,
  unsealRuntimeAuthorization,
  RuntimeAuthorizationRevokedError,
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

function adapters(): RuntimeAuthorizationAdapters {
  return {
    getPrincipal: vi.fn(async ({ userId }) => principals.get(userId) ?? null),
    getMembership: vi.fn(
      async ({ organizationId, userId }) => memberships.get(`${organizationId}:${userId}`) ?? null
    ),
  };
}

async function admission(
  options: {
    userId?: string;
    source?: 'user' | 'automation';
    audience?: string | string[];
    expiresInSeconds?: number;
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
    tokenPurpose: source === 'user' ? 'human-api' : 'internal-service',
    credentialExchange: false,
    extra: {
      organizationId: 'org',
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
        token: (await admission({ audience: 'gastown' })).token,
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

  it('seals only the exact intended runtime record', async () => {
    const result = await createRuntimeAuthorization({
      token: (await admission({ audience: 'gastown' })).token,
      secret,
      connectionString: 'postgres://unused',
      resourceKind: 'gastown',
      resourceId: 'town',
      organizationId: 'org',
      adapters: adapters(),
    });
    const sealed = await sealRuntimeAuthorization(result.authorization, secret);
    await expect(
      unsealRuntimeAuthorization(sealed, secret, {
        resourceKind: 'gastown',
        resourceId: 'town',
        userId: 'user',
        organizationId: 'org',
      })
    ).resolves.toEqual(result.authorization);
    await expect(
      unsealRuntimeAuthorization(sealed, secret, {
        resourceKind: 'gastown',
        resourceId: 'other',
        userId: 'user',
        organizationId: 'org',
      })
    ).rejects.toThrow();
    await expect(
      unsealRuntimeAuthorization(`${sealed}x`, secret, {
        resourceKind: 'gastown',
        resourceId: 'town',
        userId: 'user',
        organizationId: 'org',
      })
    ).rejects.toThrow();
  });
});
