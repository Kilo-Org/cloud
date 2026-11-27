import type { StsEnvironment } from '@kilocode/sts-contracts';
import { generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import { IdentityVerifier, type VerifyOutcome } from '../../src/identity/verify';
import { policyIndex } from '../../src/policy';
import { loadPolicies } from '../../src/policy/load';
import {
  createProvider,
  providerFetch,
  signToken,
  type CountingFetch,
  type TestProvider,
} from './support';

const STS_ISSUER = 'https://sts.test';
const SLUG_ISSUER = 'https://oidc.vercel.com/acme';
const TEAM_ID_ISSUER = 'https://oidc.vercel.com/team_Acme1';
const DEFAULT_AUDIENCE = 'https://vercel.com/acme';

const policies = loadPolicies({
  'web.yaml': `
workload: web
environments: [production, staging, development]
identity:
  kind: vercel-oidc
  teamSlug: acme
  teamId: team_Acme1
  projectId: prj_Web1
  projectName: acme-web
  environments:
    - production
    - preview
    - customEnvironmentId: env_Staging1
secrets: [APP_SECRET]
`,
});

type Fixture = {
  local: CountingFetch;
  verify: (token: string) => Promise<VerifyOutcome>;
  slug: TestProvider;
  teamId: TestProvider;
};

async function fixture(environment: StsEnvironment): Promise<Fixture> {
  const slug = await createProvider(SLUG_ISSUER, STS_ISSUER);
  const teamId = await createProvider(TEAM_ID_ISSUER, STS_ISSUER);
  const local = providerFetch([slug, teamId]);
  const verifier = new IdentityVerifier({
    policies: policies.all(),
    environment,
    audience: STS_ISSUER,
    fetch: local.fetch,
  });
  return { local, verify: token => verifier.verify(token), slug, teamId };
}

/** The claims of an exchanged function token (https://vercel.com/docs/oidc/reference). */
function vercelClaims(environment: string, overrides: JWTPayload = {}): JWTPayload {
  return {
    sub: `owner:acme:project:acme-web:environment:${environment}`,
    owner: 'acme',
    owner_id: 'team_Acme1',
    project: 'acme-web',
    project_id: 'prj_Web1',
    environment,
    act: { iat: nowSeconds() - 60, aud: DEFAULT_AUDIENCE },
    ...overrides,
  };
}

const STAGING_CLAIMS = vercelClaims('staging', { custom_environment_id: 'env_Staging1' });

function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

describe('Vercel function identity', () => {
  it('accepts an exchanged production token on production STS and exposes its exp and iat', async () => {
    const { verify, slug } = await fixture('production');
    const issuedAt = nowSeconds();
    const token = await signToken(slug, vercelClaims('production'), {
      issuedAt,
      expiresAt: issuedAt + 7200,
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'web',
      provider: 'vercel',
      attestationExp: issuedAt + 7200,
      attestationIat: issuedAt,
      run: null,
      github: null,
    });
  });

  it('refuses the team id issuer form, which no policy can name', async () => {
    const { verify, teamId } = await fixture('production');
    expect(await verify(await signToken(teamId, vercelClaims('production')))).toEqual({
      status: 'denied',
      reason: 'identity_rejected',
    });
  });

  it('refuses the team-wide default audience', async () => {
    const { verify, slug } = await fixture('production');
    const token = await signToken(slug, vercelClaims('production'), {
      audience: DEFAULT_AUDIENCE,
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses a token whose audience list names STS next to another audience', async () => {
    const { verify, slug } = await fixture('production');
    const token = await signToken(slug, vercelClaims('production'), {
      audience: [STS_ISSUER, DEFAULT_AUDIENCE],
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses another team and another project, naming only their stable ids', async () => {
    const { verify, slug } = await fixture('production');
    const otherTeam = await verify(
      await signToken(slug, vercelClaims('production', { owner_id: 'team_Other1' }))
    );
    expect(otherTeam).toEqual({
      status: 'denied',
      reason: 'unknown_workload',
      subject: {
        provider: 'vercel',
        actor: 'vercel:team_Other1/prj_Web1',
        claims: { owner_id: 'team_Other1', project_id: 'prj_Web1', environment: 'production' },
      },
    });
    const otherProject = await verify(
      await signToken(slug, vercelClaims('production', { project_id: 'prj_Other1' }))
    );
    expect(otherProject).toMatchObject({
      reason: 'unknown_workload',
      subject: { actor: 'vercel:team_Acme1/prj_Other1' },
    });
  });

  it('refuses a development token without user_id, an environment no policy may list', async () => {
    const { verify, slug } = await fixture('development');
    const token = await signToken(slug, vercelClaims('development'));
    expect(await verify(token)).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
      subject: { actor: 'web', claims: { environment: 'development' } },
    });
  });

  it('refuses a preview token on production STS and accepts it on development STS', async () => {
    const production = await fixture('production');
    expect(
      await production.verify(await signToken(production.slug, vercelClaims('preview')))
    ).toMatchObject({
      status: 'denied',
      reason: 'environment_mismatch',
      subject: { actor: 'web' },
    });
    const development = await fixture('development');
    expect(
      await development.verify(await signToken(development.slug, vercelClaims('preview')))
    ).toMatchObject({ status: 'verified', workload: 'web' });
  });

  it('refuses a production token on development STS', async () => {
    const { verify, slug } = await fixture('development');
    expect(await verify(await signToken(slug, vercelClaims('production')))).toMatchObject({
      status: 'denied',
      reason: 'environment_mismatch',
    });
  });

  it('pins a custom environment by its id, never by its slug', async () => {
    const staging = await fixture('staging');
    expect(await staging.verify(await signToken(staging.slug, STAGING_CLAIMS))).toMatchObject({
      status: 'verified',
      workload: 'web',
    });
    const otherId = await signToken(staging.slug, {
      ...STAGING_CLAIMS,
      custom_environment_id: 'env_Other1',
    });
    expect(await staging.verify(otherId)).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
    });
    const slugOnly = await signToken(staging.slug, vercelClaims('staging'));
    expect(await staging.verify(slugOnly)).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
    });

    const production = await fixture('production');
    expect(await production.verify(await signToken(production.slug, STAGING_CLAIMS))).toMatchObject(
      { status: 'denied', reason: 'environment_mismatch' }
    );
    const development = await fixture('development');
    expect(
      await development.verify(await signToken(development.slug, STAGING_CLAIMS))
    ).toMatchObject({ status: 'denied', reason: 'environment_mismatch' });
  });

  it('refuses a subject that disagrees with the token claims', async () => {
    const { verify, slug } = await fixture('production');
    const otherSubject = await signToken(
      slug,
      vercelClaims('production', { sub: 'owner:acme:project:acme-web:environment:preview' })
    );
    expect(await verify(otherSubject)).toMatchObject({ reason: 'identity_rejected' });
    const otherOwner = await signToken(
      slug,
      vercelClaims('production', {
        owner: 'other',
        sub: 'owner:other:project:acme-web:environment:production',
      })
    );
    expect(await verify(otherOwner)).toMatchObject({ reason: 'identity_rejected' });
    const numericEnvironment = await signToken(
      slug,
      vercelClaims('production', { environment: 1 })
    );
    expect(await verify(numericEnvironment)).toMatchObject({ reason: 'identity_rejected' });
  });
});

describe('Vercel tokens of a person', () => {
  it('refuses a vercel dev token carrying user_id and audits the person', async () => {
    const { verify, slug } = await fixture('development');
    const token = await signToken(slug, vercelClaims('development', { user_id: 'usr_Dev1' }), {
      expiresAt: nowSeconds() + 12 * 3600,
    });
    expect(await verify(token)).toEqual({
      status: 'denied',
      reason: 'identity_rejected',
      subject: {
        provider: 'vercel',
        actor: 'vercel:team_Acme1/prj_Web1',
        claims: {
          owner_id: 'team_Acme1',
          project_id: 'prj_Web1',
          environment: 'development',
          user_id: 'usr_Dev1',
        },
      },
    });
  });

  it.each([
    ['preview', 'development'],
    ['production', 'production'],
  ] as const)(
    'refuses a %s token carrying user_id on %s STS',
    async (vercelEnvironment, stsEnvironment) => {
      const { verify, slug } = await fixture(stsEnvironment);
      const token = await signToken(slug, vercelClaims(vercelEnvironment, { user_id: 'usr_Dev1' }));
      expect(await verify(token)).toMatchObject({
        status: 'denied',
        reason: 'identity_rejected',
        subject: { claims: { environment: vercelEnvironment, user_id: 'usr_Dev1' } },
      });
    }
  );
});

describe('Vercel exchange provenance', () => {
  it.each([
    ['without act', { act: undefined }],
    ['whose act is not an object', { act: DEFAULT_AUDIENCE }],
    ['whose act names another audience', { act: { aud: 'https://example.invalid' } }],
    ['whose act names another team', { act: { aud: 'https://vercel.com/other' } }],
    [
      'exchanged from an already exchanged token',
      { act: { aud: DEFAULT_AUDIENCE, act: { aud: 'https://example.invalid' } } },
    ],
  ])('refuses a token %s and audits it', async (_name, overrides) => {
    const { verify, slug } = await fixture('production');
    const claims = vercelClaims('production', overrides);
    if (claims.act === undefined) delete claims.act;
    expect(await verify(await signToken(slug, claims))).toEqual({
      status: 'denied',
      reason: 'identity_rejected',
      subject: {
        provider: 'vercel',
        actor: 'vercel:team_Acme1/prj_Web1',
        claims: { owner_id: 'team_Acme1', project_id: 'prj_Web1', environment: 'production' },
      },
    });
  });
});

describe('Vercel token rejection', () => {
  it.each(['HS256', 'ES256', 'none'])('refuses a token signed with %s', async algorithm => {
    const { verify } = await fixture('production');
    const claims = { ...vercelClaims('production'), iss: SLUG_ISSUER, aud: STS_ISSUER };
    let token: string;
    if (algorithm === 'none') {
      const encode = (value: unknown): string =>
        btoa(JSON.stringify(value)).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
      token = `${encode({ alg: 'none', typ: 'JWT' })}.${encode(claims)}.`;
    } else {
      const key =
        algorithm === 'HS256'
          ? new TextEncoder().encode('a-shared-secret-of-at-least-32-bytes!')
          : (await generateKeyPair('ES256')).privateKey;
      token = await new SignJWT(claims)
        .setProtectedHeader({ alg: algorithm, kid: `${SLUG_ISSUER}-key` })
        .setIssuedAt()
        .setExpirationTime('10m')
        .sign(key);
    }
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses an expired token and one issued in the future, within a 60-second skew', async () => {
    const { verify, slug } = await fixture('production');
    const now = nowSeconds();
    const expired = await signToken(slug, vercelClaims('production'), {
      issuedAt: now - 7300,
      expiresAt: now - 100,
    });
    expect(await verify(expired)).toEqual({ status: 'denied', reason: 'identity_rejected' });
    const future = await signToken(slug, vercelClaims('production'), {
      issuedAt: now + 600,
      expiresAt: now + 7800,
    });
    expect(await verify(future)).toEqual({ status: 'denied', reason: 'identity_rejected' });
    const withinSkew = await signToken(slug, vercelClaims('production'), {
      issuedAt: now + 30,
      expiresAt: now + 7200,
    });
    expect((await verify(withinSkew)).status).toBe('verified');
  });

  it.each([
    ['iat', { issuedAt: null }],
    ['exp', { expiresAt: null }],
    ['iat and exp', { issuedAt: null, expiresAt: null }],
  ] as const)('refuses a token without %s', async (_name, times) => {
    const { verify, slug } = await fixture('production');
    const token = await signToken(slug, vercelClaims('production'), times);
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });
});

describe('Vercel provider outages', () => {
  it('answers unavailable, not a rejection, when the key set cannot be fetched', async () => {
    const { verify, slug, local } = await fixture('production');
    const token = await signToken(slug, vercelClaims('production'));
    local.faults.jwks = 'error';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
    local.faults.jwks = 'unreachable';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
  });

  it('answers unavailable when discovery fails and recovers once it answers', async () => {
    const { verify, slug, local } = await fixture('production');
    const token = await signToken(slug, vercelClaims('production'));
    local.faults.discovery = 'error';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
    local.faults.discovery = 'unreachable';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
    local.faults.discovery = 'none';
    expect((await verify(token)).status).toBe('verified');
  });

  it('discovers the team issuer once and reuses its key set', async () => {
    const { verify, slug, local } = await fixture('production');
    const token = await signToken(slug, vercelClaims('production'));
    await verify(token);
    await verify(token);
    expect(local.calls.get(`${SLUG_ISSUER}/.well-known/openid-configuration`)).toBe(1);
    expect(local.calls.get(`${SLUG_ISSUER}/.well-known/jwks`)).toBe(1);
  });
});

describe('Vercel identity of the shipped ai-gateway policy', () => {
  const TEAM_ID = 'team_ItxRShuUkJaEd9GmXMEEgunb';
  const GATEWAY_PROJECT_ID = 'prj_cFtsRYRBCm4qa8D35LC2j183FohC';

  /** An exchanged kilocode-ai-gateway function token. */
  function gatewayClaims(environment: string, overrides: JWTPayload = {}): JWTPayload {
    return {
      sub: `owner:kilocode:project:kilocode-ai-gateway:environment:${environment}`,
      owner: 'kilocode',
      owner_id: TEAM_ID,
      project: 'kilocode-ai-gateway',
      project_id: GATEWAY_PROJECT_ID,
      environment,
      act: { iat: nowSeconds() - 60, aud: 'https://vercel.com/kilocode' },
      ...overrides,
    };
  }

  /** STS of one environment under the shipped policies, and a token of team kilocode's issuer. */
  async function shipped(environment: StsEnvironment) {
    const kilocode = await createProvider('https://oidc.vercel.com/kilocode', STS_ISSUER);
    const verifier = new IdentityVerifier({
      policies: policyIndex.all(),
      environment,
      audience: STS_ISSUER,
      fetch: providerFetch([kilocode]).fetch,
    });
    return async (claims: JWTPayload) => await verifier.verify(await signToken(kilocode, claims));
  }

  it('verifies a kilocode-ai-gateway preview function on development STS as ai-gateway', async () => {
    const verify = await shipped('development');
    expect(await verify(gatewayClaims('preview'))).toMatchObject({
      status: 'verified',
      workload: 'ai-gateway',
      provider: 'vercel',
    });
  });

  it('verifies a kilocode-ai-gateway production function on production STS as ai-gateway', async () => {
    const production = await shipped('production');
    expect(await production(gatewayClaims('production'))).toMatchObject({
      status: 'verified',
      workload: 'ai-gateway',
      provider: 'vercel',
    });
  });

  it('refuses every kilocode-ai-gateway environment on staging STS, and a preview on production STS', async () => {
    const staging = await shipped('staging');
    expect(await staging(gatewayClaims('preview'))).toMatchObject({
      status: 'denied',
      reason: 'environment_mismatch',
      subject: { actor: 'ai-gateway' },
    });
    // The project's custom environment staging, which the policy does not list yet.
    expect(
      await staging(
        gatewayClaims('staging', { custom_environment_id: 'env_t9p3Xr8paMqpucgHbz0gg1Xrd4PV' })
      )
    ).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
      subject: { actor: 'ai-gateway' },
    });

    const production = await shipped('production');
    expect(await production(gatewayClaims('preview'))).toMatchObject({
      status: 'denied',
      reason: 'environment_mismatch',
      subject: { actor: 'ai-gateway' },
    });
    // Production STS never serves a preview (design 6.2), and development STS never production.
    const development = await shipped('development');
    expect(await development(gatewayClaims('production'))).toMatchObject({
      status: 'denied',
      reason: 'environment_mismatch',
      subject: { actor: 'ai-gateway' },
    });
  });

  it('binds the project id and team id, never the names a token carries', async () => {
    const verify = await shipped('development');
    expect(await verify(gatewayClaims('preview', { project_id: 'prj_Other1' }))).toMatchObject({
      status: 'denied',
      reason: 'unknown_workload',
      subject: { actor: `vercel:${TEAM_ID}/prj_Other1` },
    });
    expect(await verify(gatewayClaims('preview', { owner_id: 'team_Other1' }))).toMatchObject({
      status: 'denied',
      reason: 'unknown_workload',
      subject: { actor: `vercel:team_Other1/${GATEWAY_PROJECT_ID}` },
    });
    // The gateway's names on the web app's project id name the web app, not the gateway.
    expect(
      await verify(gatewayClaims('preview', { project_id: 'prj_AAnAlIuYPrpU0aDbT1kdm0ymL7hR' }))
    ).toMatchObject({ status: 'verified', workload: 'web' });
  });
});
