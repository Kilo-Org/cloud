import { afterEach, describe, expect, it, vi } from 'vitest';
import { SignJWT } from 'jose';
import {
  LEGACY_API_TOKEN_LIFETIMES_SECONDS,
  buildModernKiloTokenPayload,
  canIssueKiloCredentials,
  isKiloResourceAudienceAllowed,
  verifyKiloSessionForPolicy,
  verifyKiloTokenForPolicy,
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

describe('canIssueKiloCredentials', () => {
  it('only accepts authentic verified session contexts', async () => {
    const session = await verifyKiloSessionForPolicy(async () => ({
      userId: 'synthetic-session-user',
    }));
    if (session === null) throw new Error('synthetic session was unexpectedly absent');
    expect(canIssueKiloCredentials(session, { legacy: 'deny' })).toBe(true);
    expect(
      canIssueKiloCredentials(
        { type: 'session', userId: 'synthetic-session-user' } as VerifiedKiloAuthContext,
        { legacy: 'deny' }
      )
    ).toBe(false);
    expect(
      canIssueKiloCredentials(
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
    expect(canIssueKiloCredentials(bearer, { legacy: 'five-year-api' })).toBe(true);
    expect(canIssueKiloCredentials({ ...bearer }, { legacy: 'five-year-api' })).toBe(false);
    const fabricated = { type: 'session', userId: 'synthetic-other-user' };
    for (const symbol of Object.getOwnPropertySymbols(bearer)) {
      Object.defineProperty(fabricated, symbol, { value: true });
    }
    expect(canIssueKiloCredentials(fabricated as VerifiedKiloAuthContext, { legacy: 'deny' })).toBe(
      false
    );
    expect(
      canIssueKiloCredentials({ id: 'synthetic-db-user' } as unknown as VerifiedKiloAuthContext, {
        legacy: 'five-year-api',
      })
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
      expect(canIssueKiloCredentials(valid, { legacy: 'five-year-api' })).toBe(true);
      expect(canIssueKiloCredentials(valid, { legacy: 'deny' })).toBe(false);
      expect(canIssueKiloCredentials(nearExpiry, { legacy: 'five-year-api' })).toBe(true);
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
    expect(canIssueKiloCredentials(context, { legacy: 'five-year-api' })).toBe(false);
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
      expect(canIssueKiloCredentials(context, { legacy: 'five-year-api' })).toBe(false);
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
    expect(canIssueKiloCredentials(context, { legacy: 'five-year-api' })).toBe(false);
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
    expect(canIssueKiloCredentials(context, { legacy: 'five-year-api' })).toBe(false);
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
    expect(canIssueKiloCredentials(pepperless, { legacy: 'five-year-api' })).toBe(false);
    expect(canIssueKiloCredentials(deviceCode, { legacy: 'five-year-api' })).toBe(true);
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
    expect(canIssueKiloCredentials(context, { legacy: 'deny' })).toBe(true);
    vi.setSystemTime(new Date((NOW_SECONDS + 1) * 1000));
    expect(canIssueKiloCredentials(context, { legacy: 'deny' })).toBe(false);
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
    expect(canIssueKiloCredentials(context, { legacy: 'deny' })).toBe(true);
    const multipleAudiences = await verifyKiloTokenForPolicy(
      await sign({ ...claims, aud: ['kilo-api', 'kilo-gateway'] }),
      SECRET,
      API_POLICY
    );
    expect(canIssueKiloCredentials(multipleAudiences, { legacy: 'deny' })).toBe(false);
    const singletonArray = await verifyKiloTokenForPolicy(
      await sign({ ...claims, aud: ['kilo-api'] }),
      SECRET,
      API_POLICY
    );
    expect(canIssueKiloCredentials(singletonArray, { legacy: 'deny' })).toBe(true);
    const wrongAudience = await verifyKiloTokenForPolicy(
      await sign({ ...claims, aud: 'kilo-gateway' }),
      SECRET,
      { audience: 'kilo-gateway', mode: 'required' }
    );
    expect(canIssueKiloCredentials(wrongAudience, { legacy: 'deny' })).toBe(false);
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
      expect(canIssueKiloCredentials(context, { legacy: 'five-year-api' })).toBe(false);
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
      expect(canIssueKiloCredentials(context, { legacy: 'five-year-api' })).toBe(false);
    }
  });
});

describe('buildModernKiloTokenPayload and compatibility', () => {
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
