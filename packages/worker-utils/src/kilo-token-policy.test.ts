import { afterEach, describe, expect, expectTypeOf, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
  LEGACY_API_TOKEN_LIFETIMES_SECONDS,
  buildModernKiloTokenPayload,
  isKiloCredentialExchangeEligible,
  isKiloResourceAudienceAllowed,
  verifyKiloSessionForPolicy,
  verifyKiloTokenForResource,
  verifyKiloTokenForPolicy,
  type ModernKiloTokenClaims,
  type VerifiedKiloAuthContext,
} from './kilo-token-policy.js';
import { verifyKiloToken } from './kilo-token.js';
import {
  BITBUCKET_REPOSITORY_LIST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
  BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
  GITLAB_CREDENTIAL_BROKER_AUDIENCE,
  GITHUB_USER_ACCESS_TOKEN_AUDIENCE,
  USER_DATA_EXPORT_AUDIENCE,
  SESSION_INGEST_USER_DELETION_AUDIENCE,
} from './internal-service-token-audiences.js';

const SECRET = 'synthetic-policy-test-secret-at-least-32-chars';
const NOW = new Date('2030-01-02T03:04:05.000Z');
const NOW_SECONDS = Math.floor(NOW.getTime() / 1000);
const HISTORICAL_FIVE_YEAR_LIFETIMES = [157_680_000, 157_788_000] as const;
const API_POLICY = { audience: 'kilo-api', mode: 'required' } as const;
const LEGACY_POLICY = { audience: 'kilo-api', mode: 'allow-legacy' } as const;

function key(secret = SECRET) {
  return new TextEncoder().encode(secret);
}

async function sign(
  claims: Record<string, unknown>,
  options: { secret?: string; algorithm?: 'HS256' | 'HS384'; nbf?: number; dates?: boolean } = {}
) {
  let jwt = new SignJWT(claims).setProtectedHeader({
    alg: options.algorithm ?? 'HS256',
    typ: 'JWT',
  });
  if (options.dates !== false) {
    jwt = jwt
      .setIssuedAt(typeof claims.iat === 'number' ? claims.iat : NOW_SECONDS)
      .setExpirationTime(typeof claims.exp === 'number' ? claims.exp : NOW_SECONDS + 300);
  }
  if (options.nbf !== undefined) jwt = jwt.setNotBefore(options.nbf);
  return jwt.sign(key(options.secret));
}

function legacyClaims(extra: Record<string, unknown> = {}) {
  return {
    version: 3,
    kiloUserId: 'synthetic-user',
    apiTokenPepper: 'synthetic-pepper',
    iat: NOW_SECONDS,
    exp: NOW_SECONDS + LEGACY_API_TOKEN_LIFETIMES_SECONDS[0],
    ...extra,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('isKiloResourceAudienceAllowed', () => {
  it.each([
    ['kilo-api', API_POLICY, true],
    [['kilo-api', 'kilo-gateway'], API_POLICY, true],
    ['kilo-gateway', API_POLICY, false],
    [undefined, LEGACY_POLICY, true],
    [undefined, API_POLICY, false],
    [[], API_POLICY, false],
    [['kilo-api', 'kilo-api'], API_POLICY, false],
    [' kilo-api', API_POLICY, false],
    [null, API_POLICY, false],
  ])('handles %j with %o', (audience, policy, expected) => {
    expect(isKiloResourceAudienceAllowed(audience, policy)).toBe(expected);
  });

  it('rejects invalid resource policy audiences', () => {
    expect(
      isKiloResourceAudienceAllowed('kilo-api', { audience: ' kilo-api', mode: 'required' })
    ).toBe(false);
  });
});

describe('verifyKiloTokenForPolicy', () => {
  it('verifies a signed audience token and returns frozen, restricted claims', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const token = await sign(
      legacyClaims({ aud: ['kilo-api', 'kilo-gateway'], deviceSessionId: 'device-session' })
    );

    const context = await verifyKiloTokenForPolicy(token, SECRET, API_POLICY);

    expect(context).toMatchObject({ type: 'bearer', userId: 'synthetic-user' });
    expect(context.claims).toMatchObject({
      aud: ['kilo-api', 'kilo-gateway'],
      deviceSessionId: 'device-session',
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.claims)).toBe(true);
    expect(Object.isFrozen(context.claims.aud)).toBe(true);
  });

  it.each([true, false, null, '', [], { restricted: true }])(
    'retains unknown claim names and refuses legacy exchange for value %j',
    async value => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const context = await verifyKiloTokenForPolicy(
        await sign(legacyClaims({ futureAutomation: value })),
        SECRET,
        LEGACY_POLICY
      );

      expect(context.claimNames).toContain('futureAutomation');
      expect(Object.isFrozen(context.claimNames)).toBe(true);
      expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);
    }
  );

  it('retains future restriction claim names while refusing modern credential exchange', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const context = await verifyKiloTokenForPolicy(
      await sign(
        legacyClaims({
          aud: 'kilo-api',
          tokenPurpose: 'human-api',
          credentialExchange: true,
          futureCredentialRestriction: true,
        })
      ),
      SECRET,
      API_POLICY
    );

    expect(context.claimNames).toContain('futureCredentialRestriction');
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'deny' })).toBe(false);
  });

  it('freezes nested organization membership claims', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const context = await verifyKiloTokenForPolicy(
      await sign(legacyClaims({ orgMemberships: [{ orgId: 'synthetic-org', role: 'member' }] })),
      SECRET,
      LEGACY_POLICY
    );

    const memberships = context.claims.orgMemberships;
    if (memberships === undefined)
      throw new Error('organization memberships were unexpectedly absent');
    expect(Object.isFrozen(memberships)).toBe(true);
    expect(Object.isFrozen(memberships[0])).toBe(true);
    expect(() =>
      Object.assign(memberships, { 0: { orgId: 'different-org', role: 'owner' } })
    ).toThrow();
    expect(() => Object.assign(memberships[0], { role: 'owner' })).toThrow();
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);
  });

  it('allows legacy operation audience tokens without requiring modern claims', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const token = await sign(legacyClaims({ aud: 'kilo-gateway' }));

    await expect(
      verifyKiloTokenForPolicy(token, SECRET, { audience: 'kilo-gateway', mode: 'required' })
    ).resolves.toMatchObject({ type: 'bearer' });
  });

  it.each([
    [BITBUCKET_REPOSITORY_LIST_AUDIENCE, 'git-token-service:bitbucket-repositories'],
    [
      BITBUCKET_CODE_REVIEW_PULL_REQUEST_AUDIENCE,
      'git-token-service:bitbucket-code-review:pull-request',
    ],
    [
      BITBUCKET_CODE_REVIEW_WEBHOOK_ENSURE_AUDIENCE,
      'git-token-service:bitbucket-code-review:webhook-ensure',
    ],
    [
      BITBUCKET_CODE_REVIEW_WEBHOOK_DELETE_AUDIENCE,
      'git-token-service:bitbucket-code-review:webhook-delete',
    ],
    [GITLAB_CREDENTIAL_BROKER_AUDIENCE, 'git-token-service:gitlab-credentials'],
    [GITHUB_USER_ACCESS_TOKEN_AUDIENCE, 'git-token-service:github-user-access-token'],
    [USER_DATA_EXPORT_AUDIENCE, 'user-data-export'],
    [SESSION_INGEST_USER_DELETION_AUDIENCE, 'session-ingest:user-deletion'],
  ])('preserves mandatory operation audience %s', async (audience, expected) => {
    expect(audience).toBe(expected);
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const token = await sign(legacyClaims({ aud: audience }));
    await expect(verifyKiloToken(token, SECRET)).rejects.toThrow();
    await expect(verifyKiloToken(token, SECRET, { audience })).resolves.toMatchObject({
      kiloUserId: 'synthetic-user',
    });
    await expect(
      verifyKiloToken(await sign(legacyClaims()), SECRET, { audience })
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForPolicy(token, SECRET, { audience, mode: 'required' })
    ).resolves.toMatchObject({ type: 'bearer' });
    await expect(verifyKiloTokenForPolicy(token, SECRET, API_POLICY)).rejects.toThrow();
    await expect(
      verifyKiloTokenForPolicy(await sign(legacyClaims()), SECRET, { audience, mode: 'required' })
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForPolicy(await sign(legacyClaims()), SECRET, {
        audience,
        mode: 'allow-legacy',
      })
    ).resolves.toMatchObject({ type: 'bearer' });
  });

  it.each([
    ['missing dates', { version: 3, kiloUserId: 'synthetic-user' }],
    ['missing issued at', { ...legacyClaims(), iat: undefined }],
    ['missing expiration', { ...legacyClaims(), exp: undefined }],
    ['negative issued at', legacyClaims({ iat: -1 })],
    ['negative expiration', legacyClaims({ exp: -1 })],
    ['string issued at', legacyClaims({ iat: '0' })],
    ['string expiration', legacyClaims({ exp: '1893553505' })],
    ['fractional expiration', legacyClaims({ exp: NOW_SECONDS + 1.5 })],
    ['unsafe issued at', legacyClaims({ iat: Number.MAX_SAFE_INTEGER + 1 })],
    ['expiration before issuance', legacyClaims({ exp: NOW_SECONDS })],
    ['future issued at', legacyClaims({ iat: NOW_SECONDS + 1, exp: NOW_SECONDS + 10 })],
    [
      'unknown purpose',
      legacyClaims({ aud: 'kilo-api', tokenPurpose: 'unknown', credentialExchange: false }),
    ],
    ['missing exchange flag', legacyClaims({ aud: 'kilo-api', tokenPurpose: 'human-api' })],
    [
      'null purpose',
      legacyClaims({ aud: 'kilo-api', tokenPurpose: null, credentialExchange: false }),
    ],
    [
      'non-human exchange',
      legacyClaims({ aud: 'kilo-api', tokenPurpose: 'device-access', credentialExchange: true }),
    ],
    ['empty audience array', legacyClaims({ aud: [] })],
    ['empty audience entry', legacyClaims({ aud: ['kilo-api', ''] })],
    ['mixed audience entries', legacyClaims({ aud: ['kilo-api', 1] })],
    ['wrong audience with legacy opt-in', legacyClaims({ aud: 'kilo-gateway' })],
    [
      'modern purpose without audience',
      legacyClaims({ tokenPurpose: 'human-api', credentialExchange: true }),
    ],
    [
      'modern exchange without purpose',
      legacyClaims({ aud: 'kilo-api', credentialExchange: true }),
    ],
    [
      'null exchange',
      legacyClaims({ aud: 'kilo-api', tokenPurpose: 'human-api', credentialExchange: null }),
    ],
    [
      'numeric exchange',
      legacyClaims({ aud: 'kilo-api', tokenPurpose: 'human-api', credentialExchange: 1 }),
    ],
    [
      'string exchange',
      legacyClaims({ aud: 'kilo-api', tokenPurpose: 'human-api', credentialExchange: 'true' }),
    ],
  ])('rejects %s', async (_name, claims) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await expect(
      verifyKiloTokenForPolicy(
        await sign(claims, {
          dates: ![
            'missing dates',
            'missing issued at',
            'missing expiration',
            'string issued at',
            'string expiration',
          ].includes(_name),
        }),
        SECRET,
        LEGACY_POLICY
      )
    ).rejects.toThrow();
  });

  it('rejects expiry, not-before, signatures, and algorithms jose validates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await expect(
      verifyKiloTokenForPolicy(
        await sign(legacyClaims({ exp: NOW_SECONDS - 1 })),
        SECRET,
        LEGACY_POLICY
      )
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForPolicy(
        await sign(legacyClaims(), { nbf: NOW_SECONDS + 1 }),
        SECRET,
        LEGACY_POLICY
      )
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForPolicy(
        await sign(legacyClaims(), { secret: 'another-synthetic-test-secret-at-least-32' }),
        SECRET,
        LEGACY_POLICY
      )
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForPolicy(
        await sign(legacyClaims(), { algorithm: 'HS384' }),
        SECRET,
        LEGACY_POLICY
      )
    ).rejects.toThrow();
  });
});

describe('verifyKiloTokenForResource', () => {
  it.each([
    ['matching audience', legacyClaims({ aud: 'kilo-api' }), API_POLICY, true],
    [
      'matching audience array',
      legacyClaims({ aud: ['kilo-gateway', 'kilo-api'] }),
      API_POLICY,
      true,
    ],
    ['missing required audience', legacyClaims(), API_POLICY, false],
    ['missing legacy audience', legacyClaims(), LEGACY_POLICY, true],
    ['mismatched audience', legacyClaims({ aud: 'kilo-gateway' }), API_POLICY, false],
    ['null audience', legacyClaims({ aud: null }), API_POLICY, false],
    ['empty audience', legacyClaims({ aud: '' }), API_POLICY, false],
    ['numeric audience', legacyClaims({ aud: 1 }), API_POLICY, false],
    ['empty audience array', legacyClaims({ aud: [] }), API_POLICY, false],
    [
      'duplicate audience members',
      legacyClaims({ aud: ['kilo-api', 'kilo-api'] }),
      API_POLICY,
      false,
    ],
    [
      'trimmed audience member',
      legacyClaims({ aud: ['kilo-api', ' kilo-gateway'] }),
      API_POLICY,
      false,
    ],
    ['numeric audience member', legacyClaims({ aud: ['kilo-api', 1] }), API_POLICY, false],
  ])('handles %s', async (_name, claims, policy, allowed) => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const verification = verifyKiloTokenForResource(await sign(claims), SECRET, policy);
    if (allowed) {
      await expect(verification).resolves.toMatchObject({ kiloUserId: 'synthetic-user' });
    } else {
      await expect(verification).rejects.toThrow();
    }
  });

  it.each(['', ' kilo-api', 'kilo-api '])(
    'fails closed for invalid configured audience %j',
    async audience => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      await expect(
        verifyKiloTokenForResource(await sign(legacyClaims({ aud: 'kilo-api' })), SECRET, {
          audience,
          mode: 'required',
        })
      ).rejects.toThrow();
    }
  );

  it('preserves known legacy claims and strips ignored unknown claims', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const payload = await verifyKiloTokenForResource(
      await sign(
        legacyClaims({
          aud: 'kilo-api',
          apiTokenPepper: null,
          env: 'production',
          botId: 'synthetic-bot',
          tokenPurpose: 'human-api',
          credentialExchange: true,
          ignoredFutureResourceClaim: true,
        })
      ),
      SECRET,
      API_POLICY
    );

    expect(payload).toMatchObject({
      kiloUserId: 'synthetic-user',
      apiTokenPepper: null,
      env: 'production',
      botId: 'synthetic-bot',
    });
    expect(payload).not.toHaveProperty('ignoredFutureResourceClaim');
    expect(payload).not.toHaveProperty('tokenPurpose');
    expect(payload).not.toHaveProperty('credentialExchange');
  });

  it('preserves optional dates and jose temporal behavior', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const undated = await verifyKiloTokenForResource(
      await sign({ version: 3, kiloUserId: 'synthetic-user', aud: 'kilo-api' }, { dates: false }),
      SECRET,
      API_POLICY
    );
    expect(undated).not.toHaveProperty('iat');
    expect(undated).not.toHaveProperty('exp');
    await expect(
      verifyKiloTokenForResource(
        await sign(legacyClaims({ aud: 'kilo-api', iat: NOW_SECONDS + 1, exp: NOW_SECONDS + 10 })),
        SECRET,
        API_POLICY
      )
    ).resolves.toMatchObject({ iat: NOW_SECONDS + 1 });
    await expect(
      verifyKiloTokenForResource(
        await sign(legacyClaims({ aud: 'kilo-api', exp: NOW_SECONDS + 1.5 })),
        SECRET,
        API_POLICY
      )
    ).resolves.toMatchObject({ exp: NOW_SECONDS + 1.5 });
  });

  it('rejects malformed, expired, not-before, signature, version, and user failures', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    await expect(verifyKiloTokenForResource('not.a.token', SECRET, API_POLICY)).rejects.toThrow();
    await expect(
      verifyKiloTokenForResource(
        await sign(legacyClaims({ aud: 'kilo-api', exp: NOW_SECONDS - 1 })),
        SECRET,
        API_POLICY
      )
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForResource(
        await sign(legacyClaims({ aud: 'kilo-api' }), { nbf: NOW_SECONDS + 1 }),
        SECRET,
        API_POLICY
      )
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForResource(
        await sign(legacyClaims({ aud: 'kilo-api' }), { secret: 'another-secret' }),
        SECRET,
        API_POLICY
      )
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForResource(
        await sign({ version: 2, kiloUserId: 'synthetic-user', aud: 'kilo-api' }),
        SECRET,
        API_POLICY
      )
    ).rejects.toThrow();
    await expect(
      verifyKiloTokenForResource(await sign({ version: 3, aud: 'kilo-api' }), SECRET, API_POLICY)
    ).rejects.toThrow();
  });
});

describe('isKiloCredentialExchangeEligible', () => {
  it('only accepts authentic verified session contexts', async () => {
    const session = await verifyKiloSessionForPolicy(async () => ({
      userId: 'synthetic-session-user',
    }));
    if (session === null) throw new Error('synthetic session was unexpectedly absent');
    expect(isKiloCredentialExchangeEligible(session, { legacy: 'deny' })).toBe(true);
    expect(
      isKiloCredentialExchangeEligible(
        { type: 'session', userId: 'synthetic-session-user' } as VerifiedKiloAuthContext,
        { legacy: 'deny' }
      )
    ).toBe(false);
    expect(
      isKiloCredentialExchangeEligible(
        {
          type: 'bearer',
          userId: 'synthetic-user',
          claims: legacyClaims(),
        } as VerifiedKiloAuthContext,
        { legacy: 'five-year-api' }
      )
    ).toBe(false);
  });

  it('rejects cloned contexts and copied provenance symbols', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const bearer = await verifyKiloTokenForPolicy(
      await sign(legacyClaims()),
      SECRET,
      LEGACY_POLICY
    );
    expect(isKiloCredentialExchangeEligible(bearer, { legacy: 'five-year-api' })).toBe(true);
    expect(isKiloCredentialExchangeEligible({ ...bearer }, { legacy: 'five-year-api' })).toBe(
      false
    );
    const fabricated = { type: 'session', userId: 'synthetic-other-user' };
    for (const symbol of Object.getOwnPropertySymbols(bearer)) {
      Object.defineProperty(fabricated, symbol, { value: true });
    }
    expect(
      isKiloCredentialExchangeEligible(fabricated as VerifiedKiloAuthContext, { legacy: 'deny' })
    ).toBe(false);
    expect(
      isKiloCredentialExchangeEligible(
        { id: 'synthetic-db-user' } as unknown as VerifiedKiloAuthContext,
        {
          legacy: 'five-year-api',
        }
      )
    ).toBe(false);
  });

  it('requires a trusted session callback and validates its result', async () => {
    await expect(verifyKiloSessionForPolicy(undefined as never)).rejects.toThrow();
    await expect(verifyKiloSessionForPolicy(async () => null)).resolves.toBeNull();
    await expect(verifyKiloSessionForPolicy(async () => ({ userId: '' }))).rejects.toThrow();
    await expect(
      verifyKiloSessionForPolicy(async () =>
        Promise.reject(new Error('synthetic dependency unavailable'))
      )
    ).rejects.toThrow('synthetic dependency unavailable');
  });

  it.each(HISTORICAL_FIVE_YEAR_LIFETIMES)(
    'permits historical %i-second legacy API tokens, including near expiry',
    async lifetime => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      expect(LEGACY_API_TOKEN_LIFETIMES_SECONDS).toContain(lifetime);
      const valid = await verifyKiloTokenForPolicy(
        await sign(legacyClaims({ exp: NOW_SECONDS + lifetime })),
        SECRET,
        LEGACY_POLICY
      );
      const nearExpiry = await verifyKiloTokenForPolicy(
        await sign(
          legacyClaims({
            iat: NOW_SECONDS - lifetime + 1,
            exp: NOW_SECONDS + 1,
          })
        ),
        SECRET,
        LEGACY_POLICY
      );
      expect(isKiloCredentialExchangeEligible(valid, { legacy: 'five-year-api' })).toBe(true);
      expect(isKiloCredentialExchangeEligible(valid, { legacy: 'deny' })).toBe(false);
      expect(isKiloCredentialExchangeEligible(nearExpiry, { legacy: 'five-year-api' })).toBe(true);
    }
  );

  it.each([
    6 * 60 * 60,
    24 * 60 * 60,
    30 * 24 * 60 * 60,
    ...HISTORICAL_FIVE_YEAR_LIFETIMES.map(lifetime => lifetime - 1),
    ...HISTORICAL_FIVE_YEAR_LIFETIMES.map(lifetime => lifetime + 1),
  ])('rejects legacy original lifetime %i seconds', async lifetime => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const context = await verifyKiloTokenForPolicy(
      await sign(legacyClaims({ exp: NOW_SECONDS + lifetime })),
      SECRET,
      LEGACY_POLICY
    );
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);
  });

  it.each([
    ['tokenSource', ''],
    ['botId', ''],
    ['internalApiUse', false],
    ['createdOnPlatform', ''],
    ['deviceSessionId', ''],
    ['gastownAccess', false],
    ['isAdmin', false],
    ['orgMemberships', []],
    ['organizationId', ''],
  ])(
    'denies legacy bearer credentials when %s has a false or empty value',
    async (marker, value) => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const context = await verifyKiloTokenForPolicy(
        await sign(legacyClaims({ [marker]: value })),
        SECRET,
        LEGACY_POLICY
      );
      expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);
    }
  );

  it('rejects a longer original lifetime even when exactly five years remain', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const context = await verifyKiloTokenForPolicy(
      await sign(legacyClaims({ iat: NOW_SECONDS - 1, exp: NOW_SECONDS + 157_680_000 })),
      SECRET,
      LEGACY_POLICY
    );
    expect(context.claims.exp - context.claims.iat).toBe(157_680_001);
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);
  });

  it.each([
    'tokenSource',
    'botId',
    'internalApiUse',
    'createdOnPlatform',
    'deviceSessionId',
    'gastownAccess',
    'isAdmin',
    'orgMemberships',
    'organizationId',
    'organizationRole',
  ])('denies legacy bearer credentials when %s is present', async marker => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const value =
      marker === 'isAdmin' || marker === 'internalApiUse' || marker === 'gastownAccess'
        ? true
        : marker === 'orgMemberships'
          ? [{ orgId: 'synthetic-org', role: 'member' }]
          : marker === 'organizationRole'
            ? 'member'
            : 'present';
    const context = await verifyKiloTokenForPolicy(
      await sign(legacyClaims({ [marker]: value })),
      SECRET,
      LEGACY_POLICY
    );
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);
  });

  it('denies pepperless tokens but permits device authorization request codes', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const pepperless = await verifyKiloTokenForPolicy(
      await sign(legacyClaims({ apiTokenPepper: undefined })),
      SECRET,
      LEGACY_POLICY
    );
    const deviceCode = await verifyKiloTokenForPolicy(
      await sign(legacyClaims({ deviceAuthRequestCode: 'request-code' })),
      SECRET,
      LEGACY_POLICY
    );
    expect(isKiloCredentialExchangeEligible(pepperless, { legacy: 'five-year-api' })).toBe(false);
    expect(isKiloCredentialExchangeEligible(deviceCode, { legacy: 'five-year-api' })).toBe(true);
  });

  it('uses decision time rather than verification time for an eligible modern bearer expiry', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const claims = buildModernKiloTokenPayload({
      userId: 'synthetic-user',
      pepper: null,
      audience: 'kilo-api',
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 1,
      tokenPurpose: 'human-api',
      credentialExchange: true,
    });
    const context = await verifyKiloTokenForPolicy(await sign(claims), SECRET, API_POLICY);
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'deny' })).toBe(true);
    vi.setSystemTime(new Date((NOW_SECONDS + 1) * 1000));
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'deny' })).toBe(false);
  });

  it('permits explicitly exchangeable modern human API tokens only for the sole API audience', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const claims = buildModernKiloTokenPayload({
      userId: 'synthetic-user',
      pepper: 'synthetic-pepper',
      audience: 'kilo-api',
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
      tokenPurpose: 'human-api',
      credentialExchange: true,
    });
    const context = await verifyKiloTokenForPolicy(await sign(claims), SECRET, API_POLICY);
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'deny' })).toBe(true);
    const multipleAudiences = await verifyKiloTokenForPolicy(
      await sign({ ...claims, aud: ['kilo-api', 'kilo-gateway'] }),
      SECRET,
      API_POLICY
    );
    expect(isKiloCredentialExchangeEligible(multipleAudiences, { legacy: 'deny' })).toBe(false);
    const singletonArray = await verifyKiloTokenForPolicy(
      await sign({ ...claims, aud: ['kilo-api'] }),
      SECRET,
      API_POLICY
    );
    expect(isKiloCredentialExchangeEligible(singletonArray, { legacy: 'deny' })).toBe(true);
    const wrongAudience = await verifyKiloTokenForPolicy(
      await sign({ ...claims, aud: 'kilo-gateway' }),
      SECRET,
      { audience: 'kilo-gateway', mode: 'required' }
    );
    expect(isKiloCredentialExchangeEligible(wrongAudience, { legacy: 'deny' })).toBe(false);
  });

  it.each([
    ['a token-source marker', { extra: { tokenSource: 'automation' } }],
    ['a bot marker', { extra: { botId: 'synthetic-bot' } }],
    ['an internal marker', { extra: { internalApiUse: false } }],
    ['a platform marker', { extra: { createdOnPlatform: '' } }],
    ['a device session', { extra: { deviceSessionId: '' } }],
    ['an organization', { extra: { organizationId: 'synthetic-org' } }],
    ['an organization role', { extra: { organizationRole: 'member' } }],
    ['organization memberships', { extra: { orgMemberships: [] } }],
    ['an admin marker', { extra: { isAdmin: false } }],
    ['a Gastown marker', { extra: { gastownAccess: false } }],
    ['a wrong audience', { audience: 'kilo-gateway' }],
    ['a missing pepper', { pepper: undefined }],
  ] satisfies [string, Partial<Parameters<typeof buildModernKiloTokenPayload>[0]>][])(
    'rejects builder-generated exchangeable human API tokens with %s',
    (_name, overrides) => {
      expect(() =>
        buildModernKiloTokenPayload({
          userId: 'synthetic-user',
          pepper: 'synthetic-pepper',
          audience: 'kilo-api',
          issuedAt: NOW_SECONDS,
          expiresAt: NOW_SECONDS + 60,
          tokenPurpose: 'human-api',
          credentialExchange: true,
          ...overrides,
        })
      ).toThrow();
    }
  );

  it('round-trips exchangeable builder output with exchange-safe extras', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const claims = buildModernKiloTokenPayload({
      userId: 'synthetic-user',
      pepper: null,
      audience: 'kilo-api',
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
      tokenPurpose: 'human-api',
      credentialExchange: true,
      extra: { deviceAuthRequestCode: 'synthetic-request-code' },
    });
    const context = await verifyKiloTokenForPolicy(await sign(claims), SECRET, API_POLICY);
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'deny' })).toBe(true);
  });

  it('allows undefined optional extras that are omitted from the signed JWT', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const claims = buildModernKiloTokenPayload({
      userId: 'synthetic-user',
      pepper: null,
      audience: 'kilo-api',
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
      tokenPurpose: 'human-api',
      credentialExchange: true,
      extra: {
        tokenSource: undefined,
        botId: undefined,
        internalApiUse: undefined,
        orgMemberships: undefined,
      },
    });
    const context = await verifyKiloTokenForPolicy(await sign(claims), SECRET, API_POLICY);
    expect(context.claimNames).not.toContain('tokenSource');
    expect(context.claimNames).not.toContain('botId');
    expect(context.claimNames).not.toContain('internalApiUse');
    expect(context.claimNames).not.toContain('orgMemberships');
    expect(isKiloCredentialExchangeEligible(context, { legacy: 'deny' })).toBe(true);
  });

  it('allows builder-generated non-exchangeable modern token extras at resource verification', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const claims = buildModernKiloTokenPayload({
      userId: 'synthetic-user',
      pepper: 'synthetic-pepper',
      audience: 'kilo-api',
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
      tokenPurpose: 'device-access',
      credentialExchange: false,
      extra: { botId: 'synthetic-bot', tokenSource: 'automation' },
    });

    await expect(
      verifyKiloTokenForPolicy(await sign(claims), SECRET, API_POLICY)
    ).resolves.toMatchObject({
      userId: 'synthetic-user',
      claims: { botId: 'synthetic-bot', tokenSource: 'automation' },
    });
  });

  it.each(['device-access', 'delegated-workload', 'internal-service'] as const)(
    'denies %s modern tokens despite legacy opt-in',
    async tokenPurpose => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      const context = await verifyKiloTokenForPolicy(
        await sign(legacyClaims({ aud: 'kilo-api', tokenPurpose, credentialExchange: false })),
        SECRET,
        API_POLICY
      );
      expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);
    }
  );

  it('denies non-exchangeable human, audience-only, and marked modern bearer tokens', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const human = legacyClaims({
      aud: 'kilo-api',
      tokenPurpose: 'human-api',
      credentialExchange: false,
    });
    const audienceOnly = legacyClaims({ aud: 'kilo-api' });
    const marked = legacyClaims({
      aud: 'kilo-api',
      tokenPurpose: 'human-api',
      credentialExchange: true,
      tokenSource: '',
    });
    for (const claims of [human, audienceOnly, marked]) {
      const context = await verifyKiloTokenForPolicy(await sign(claims), SECRET, API_POLICY);
      expect(isKiloCredentialExchangeEligible(context, { legacy: 'five-year-api' })).toBe(false);
    }
  });
});

describe('buildModernKiloTokenPayload and compatibility', () => {
  type DeviceAccessModernKiloTokenClaims = ModernKiloTokenClaims & {
    tokenPurpose: 'device-access';
  };
  type ExpectedReadonlyOrganizationMemberships = readonly {
    readonly orgId: string;
    readonly role: 'owner' | 'member' | 'billing_manager';
  }[];

  expectTypeOf<DeviceAccessModernKiloTokenClaims['credentialExchange']>().toEqualTypeOf<false>();
  expectTypeOf<ExpectedReadonlyOrganizationMemberships>().toEqualTypeOf<
    NonNullable<Extract<VerifiedKiloAuthContext, { type: 'bearer' }>['claims']['orgMemberships']>
  >();

  it('builds a signable modern payload that policy verification round-trips', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const payload = buildModernKiloTokenPayload({
      userId: 'synthetic-user',
      audience: 'kilo-api',
      issuedAt: NOW_SECONDS,
      expiresAt: NOW_SECONDS + 60,
      tokenPurpose: 'human-api',
      credentialExchange: false,
      extra: { deviceAuthRequestCode: 'request-code' },
    });
    expect(payload).toMatchObject({ version: 3, kiloUserId: 'synthetic-user', aud: 'kilo-api' });
    await expect(
      verifyKiloTokenForPolicy(await sign(payload), SECRET, API_POLICY)
    ).resolves.toMatchObject({ userId: 'synthetic-user' });
  });

  it.each([
    { audience: ['kilo-api'] },
    { issuedAt: -1 },
    { expiresAt: NOW_SECONDS },
    { tokenPurpose: 'device-access', credentialExchange: true },
    { tokenPurpose: undefined, credentialExchange: undefined },
    { extra: { version: 3 } },
    { extra: { kiloUserId: 'other-user' } },
    { extra: { apiTokenPepper: null } },
    { extra: { env: 'production' } },
    { extra: { aud: 'kilo-api' } },
    { extra: { iat: NOW_SECONDS } },
    { extra: { exp: NOW_SECONDS + 60 } },
    { extra: { nbf: NOW_SECONDS } },
    { extra: { iss: 'synthetic-issuer' } },
    { extra: { sub: 'synthetic-subject' } },
    { extra: { jti: 'synthetic-id' } },
    { extra: { tokenPurpose: 'human-api' } },
    { extra: { credentialExchange: false } },
    { extra: { unknown: true } },
    { extra: { unknown: undefined } },
    { extra: { tokenPurpose: undefined } },
    { extra: { apiTokenPepper: undefined } },
  ])('rejects invalid builder inputs: %o', invalid => {
    expect(() =>
      buildModernKiloTokenPayload({
        userId: 'synthetic-user',
        audience: 'kilo-api',
        issuedAt: NOW_SECONDS,
        expiresAt: NOW_SECONDS + 60,
        tokenPurpose: 'human-api',
        credentialExchange: false,
        ...invalid,
      } as never)
    ).toThrow();
  });

  it('leaves the legacy verifier behavior unchanged for audiences, stripped modern fields, and absent dates', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    const audienceToken = await sign({ version: 3, kiloUserId: 'synthetic-user', aud: 'kilo-api' });
    await expect(verifyKiloToken(audienceToken, SECRET)).rejects.toThrow();
    await expect(
      verifyKiloToken(audienceToken, SECRET, { audience: 'kilo-api' })
    ).resolves.toMatchObject({ kiloUserId: 'synthetic-user' });
    await expect(
      verifyKiloTokenForPolicy(audienceToken, SECRET, API_POLICY)
    ).resolves.toMatchObject({ userId: 'synthetic-user' });
    const noDates = await new SignJWT({
      version: 3,
      kiloUserId: 'synthetic-user',
      tokenPurpose: 'unrecognized',
    })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(key());
    await expect(verifyKiloToken(noDates, SECRET)).resolves.toEqual({
      version: 3,
      kiloUserId: 'synthetic-user',
    });
    await expect(verifyKiloTokenForPolicy(noDates, SECRET, LEGACY_POLICY)).rejects.toThrow();
  });
});
