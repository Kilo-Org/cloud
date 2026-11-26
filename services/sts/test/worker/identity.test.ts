import { describe, expect, it } from 'vitest';
import { IdentityVerifier, type VerifyOutcome } from '../../src/identity/verify';
import { loadPolicies } from '../../src/policy/load';
import {
  createProvider,
  providerFetch,
  signToken,
  type CountingFetch,
  type TestProvider,
} from './support';

const STS_ISSUER = 'https://sts.test';
const FLY_ISSUER = 'https://oidc.fly.io/acme';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';

const policies = loadPolicies({
  'fly-app.yaml': `
workload: fly-app
environments: [production, staging]
identity:
  kind: fly-oidc
  org: acme
  orgId: '1111'
  app: fly-app
  appId: '2222'
secrets: [APP_SECRET]
`,
  'github-deploy.yaml': `
workload: github-deploy
environments: [production]
identity:
  kind: github-oidc
  repositoryId: '123'
  repositoryOwnerId: '456'
  environments: [production]
  refs: [refs/heads/main]
secrets: [APP_SECRET]
`,
  'github-review.yaml': `
workload: github-review
environments: [staging]
identity:
  kind: github-oidc
  repositoryId: '789'
  repositoryOwnerId: '456'
  refs: [refs/heads/main]
  allowedEvents: [workflow_run]
secrets: [APP_SECRET]
`,
});

type Fixture = {
  local: CountingFetch;
  verify: (token: string) => Promise<VerifyOutcome>;
  provider: (issuer: string) => TestProvider;
};

async function fixture(environment: 'production' | 'staging'): Promise<Fixture> {
  const providers = [
    await createProvider(FLY_ISSUER, STS_ISSUER),
    await createProvider(GITHUB_ISSUER, STS_ISSUER),
  ];
  const local = providerFetch(providers);
  const verifier = new IdentityVerifier({
    policies: policies.all(),
    environment,
    issuer: STS_ISSUER,
    fetch: local.fetch,
  });
  return {
    local,
    verify: token => verifier.verify(token),
    provider: issuer => {
      const found = providers.find(candidate => candidate.issuer === issuer);
      if (found === undefined) throw new Error(`no test provider for ${issuer}`);
      return found;
    },
  };
}

const FLY_CLAIMS = {
  org_id: '1111',
  org_name: 'acme',
  app_id: '2222',
  app_name: 'fly-app',
  machine_id: 'machine-1',
};

const GITHUB_CLAIMS = {
  repository_id: '123',
  repository_owner_id: '456',
  repository: 'acme/repo',
  environment: 'production',
  ref: 'refs/heads/main',
  event_name: 'push',
};

describe('Fly machine identity', () => {
  it('accepts a machine token bound to the policy org and app ids, with its exp and iat', async () => {
    const { verify, provider } = await fixture('production');
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signToken(provider(FLY_ISSUER), FLY_CLAIMS, {
      issuedAt,
      expiresAt: issuedAt + 900,
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'fly-app',
      provider: 'fly',
      attestationExp: issuedAt + 900,
      attestationIat: issuedAt,
    });
  });

  it('refuses a token issued more than the clock skew in the future', async () => {
    const { verify, provider } = await fixture('production');
    const issuedAt = Math.floor(Date.now() / 1000) + 120;
    const token = await signToken(provider(FLY_ISSUER), FLY_CLAIMS, {
      issuedAt,
      expiresAt: issuedAt + 900,
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses an app with the policy name but another app id', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), { ...FLY_CLAIMS, app_id: '9999' });
    expect(await verify(token)).toMatchObject({ status: 'denied', reason: 'unknown_workload' });
  });

  it('refuses an org id that differs from the policy', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), { ...FLY_CLAIMS, org_id: '3333' });
    expect(await verify(token)).toMatchObject({ status: 'denied', reason: 'unknown_workload' });
  });

  it('refuses the default Fly audience instead of the STS issuer', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), FLY_CLAIMS, {
      audience: 'https://fly.io/acme',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });
});

describe('GitHub Actions identity', () => {
  it('accepts a token bound to the repository ids, the environment and the ref', async () => {
    const { verify, provider } = await fixture('production');
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signToken(provider(GITHUB_ISSUER), GITHUB_CLAIMS, {
      issuedAt,
      expiresAt: issuedAt + 300,
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'github-deploy',
      provider: 'github',
      attestationExp: issuedAt + 300,
      attestationIat: issuedAt,
    });
  });

  it('refuses a token without the bound GitHub environment', async () => {
    const { verify, provider } = await fixture('production');
    const withoutEnvironment: Record<string, string> = { ...GITHUB_CLAIMS };
    delete withoutEnvironment.environment;
    const token = await signToken(provider(GITHUB_ISSUER), withoutEnvironment);
    expect(await verify(token)).toMatchObject({ status: 'denied', reason: 'identity_rejected' });
  });

  it('keeps refs as an extra filter next to the environment', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      ...GITHUB_CLAIMS,
      ref: 'refs/heads/feature',
    });
    expect(await verify(token)).toMatchObject({ status: 'denied', reason: 'identity_rejected' });
  });

  it.each(['pull_request_target', 'workflow_run', 'issue_comment'])(
    'refuses a %s token the policy does not allow',
    async event => {
      const { verify, provider } = await fixture('production');
      const token = await signToken(provider(GITHUB_ISSUER), {
        ...GITHUB_CLAIMS,
        event_name: event,
      });
      expect(await verify(token)).toMatchObject({ status: 'denied', reason: 'identity_rejected' });
    }
  );

  it('accepts a privileged event the policy names explicitly', async () => {
    const { verify, provider } = await fixture('staging');
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signToken(
      provider(GITHUB_ISSUER),
      {
        repository_id: '789',
        repository_owner_id: '456',
        ref: 'refs/heads/main',
        event_name: 'workflow_run',
      },
      { issuedAt, expiresAt: issuedAt + 300 }
    );
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'github-review',
      provider: 'github',
      attestationExp: issuedAt + 300,
      attestationIat: issuedAt,
    });
  });

  it('refuses a token from another repository', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      ...GITHUB_CLAIMS,
      repository_id: '999',
    });
    expect(await verify(token)).toMatchObject({ status: 'denied', reason: 'unknown_workload' });
  });

  it('reports an environment mismatch for a policy this deployment does not serve', async () => {
    const { verify, provider } = await fixture('staging');
    expect(await verify(await signToken(provider(GITHUB_ISSUER), GITHUB_CLAIMS))).toMatchObject({
      status: 'denied',
      reason: 'environment_mismatch',
    });
  });
});

describe('denial subjects', () => {
  it('names the stable ids of a verified token that no policy grants', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      ...GITHUB_CLAIMS,
      repository_id: '999',
    });
    const outcome = await verify(token);
    expect(outcome).toEqual({
      status: 'denied',
      reason: 'unknown_workload',
      subject: {
        provider: 'github',
        actor: 'github:999',
        claims: {
          repository_id: '999',
          repository_owner_id: '456',
          repository: 'acme/repo',
          environment: 'production',
          ref: 'refs/heads/main',
          event_name: 'push',
        },
      },
    });
    expect(JSON.stringify(outcome)).not.toContain(token);
  });

  it('names the policy workload when a verified token fails its binding', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), { ...FLY_CLAIMS, app_id: '9999' });
    expect(await verify(token)).toMatchObject({
      reason: 'unknown_workload',
      subject: { provider: 'fly', actor: 'fly:1111/9999' },
    });
    const github = await signToken(provider(GITHUB_ISSUER), {
      ...GITHUB_CLAIMS,
      ref: 'refs/heads/feature',
    });
    expect(await verify(github)).toMatchObject({
      reason: 'identity_rejected',
      subject: { actor: 'github-deploy' },
    });
  });

  it('carries no subject for a token whose signature did not verify', async () => {
    const { verify } = await fixture('production');
    const impostor = await createProvider(FLY_ISSUER, STS_ISSUER);
    expect(await verify(await signToken(impostor, FLY_CLAIMS))).not.toHaveProperty('subject');
    expect(await verify('not-a-jwt')).not.toHaveProperty('subject');
  });
});

describe('token rejection', () => {
  it('refuses a foreign issuer', async () => {
    const { verify } = await fixture('production');
    const foreign = await createProvider('https://issuer.example', STS_ISSUER);
    const token = await signToken(foreign, { sub: 'someone' });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses a token signed by a key the provider does not publish', async () => {
    const { verify } = await fixture('production');
    const impostor = await createProvider(FLY_ISSUER, STS_ISSUER);
    expect(await verify(await signToken(impostor, FLY_CLAIMS))).toEqual({
      status: 'denied',
      reason: 'identity_rejected',
    });
  });

  it('refuses a malformed token', async () => {
    const { verify } = await fixture('production');
    expect(await verify('not-a-jwt')).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it.each([
    ['Fly', FLY_ISSUER, FLY_CLAIMS],
    ['GitHub', GITHUB_ISSUER, GITHUB_CLAIMS],
  ])('refuses a %s token without iat or without exp', async (_name, issuer, claims) => {
    const { verify, provider } = await fixture('production');
    for (const times of [
      { issuedAt: null },
      { expiresAt: null },
      { issuedAt: null, expiresAt: null },
    ]) {
      const token = await signToken(provider(issuer), claims, times);
      expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
    }
  });
});

describe('provider outages', () => {
  it('answers unavailable, not a rejection, when discovery fails', async () => {
    const { verify, provider, local } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), FLY_CLAIMS);
    local.faults.discovery = 'error';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
    local.faults.discovery = 'unreachable';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
  });

  it('answers unavailable when the key set cannot be fetched', async () => {
    const { verify, provider, local } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), FLY_CLAIMS);
    local.faults.jwks = 'error';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
    local.faults.jwks = 'unreachable';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
  });

  it('does not cache a failed discovery, so the next request recovers', async () => {
    const { verify, provider, local } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), FLY_CLAIMS);
    local.faults.discovery = 'error';
    expect(await verify(token)).toEqual({ status: 'unavailable' });
    local.faults.discovery = 'none';
    expect((await verify(token)).status).toBe('verified');
  });
});

describe('key set caching', () => {
  it('discovers a provider once per verifier and reuses the key set', async () => {
    const { verify, local, provider } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), FLY_CLAIMS);
    await verify(token);
    await verify(token);
    expect(local.calls.get(`${FLY_ISSUER}/.well-known/openid-configuration`)).toBe(1);
    expect(local.calls.get(`${FLY_ISSUER}/.well-known/jwks`)).toBe(1);
  });
});
