import { describe, expect, it } from 'vitest';
import { IdentityVerifier, type VerifyOutcome } from '../../src/identity/verify';
import { loadPolicies } from '../../src/policy/load';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';

const STS_ISSUER = 'https://sts.test';

const VERCEL_ISSUER = 'https://oidc.vercel.com/acme';
const FLY_ISSUER = 'https://oidc.fly.io/acme';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';

const policies = loadPolicies({
  'vercel-app.yaml': `
workload: vercel-app
environments: [production]
identity:
  kind: vercel-oidc
  teamSlug: acme
  projectId: prj_acme_website
  vercelEnvironments: [production]
secrets: [APP_SECRET]
`,
  'vercel-preview.yaml': `
workload: vercel-preview
environments: [staging]
identity:
  kind: vercel-oidc
  teamSlug: acme
  projectId: prj_preview
  vercelEnvironments: [preview]
secrets: [APP_SECRET]
`,
  'fly-app.yaml': `
workload: fly-app
environments: [production, staging]
identity:
  kind: fly-oidc
  org: acme
  app: fly-app
secrets: [APP_SECRET]
`,
  'github-app.yaml': `
workload: github-app
environments: [production]
identity:
  kind: github-oidc
  repositoryId: '123'
  repositoryOwnerId: '456'
  refs: [refs/heads/main]
secrets: [APP_SECRET]
`,
  'github-env.yaml': `
workload: github-env
environments: [production]
identity:
  kind: github-oidc
  repositoryId: '789'
  repositoryOwnerId: '456'
  environments: [production]
secrets: [APP_SECRET]
`,
});

type Fixture = {
  providers: TestProvider[];
  calls: Map<string, number>;
  verify: (token: string) => Promise<VerifyOutcome>;
  provider: (issuer: string) => TestProvider;
};

async function fixture(environment: 'production' | 'staging'): Promise<Fixture> {
  const providers = [
    await createProvider(VERCEL_ISSUER, 'https://vercel.com/acme'),
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
    providers,
    calls: local.calls,
    verify: token => verifier.verify(token),
    provider: issuer => {
      const found = providers.find(candidate => candidate.issuer === issuer);
      if (found === undefined) throw new Error(`no test provider for ${issuer}`);
      return found;
    },
  };
}

describe('Vercel workload identity', () => {
  it('accepts a production token bound to the policy project and environment', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(VERCEL_ISSUER), {
      project_id: 'prj_acme_website',
      environment: 'production',
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'vercel-app',
      provider: 'vercel',
    });
  });

  it('refuses a preview token in the production deployment', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(VERCEL_ISSUER), {
      project_id: 'prj_acme_website',
      environment: 'preview',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'environment_mismatch' });
  });

  it('serves non-production Vercel environments from the staging deployment', async () => {
    const { verify, provider } = await fixture('staging');
    const token = await signToken(provider(VERCEL_ISSUER), {
      project_id: 'prj_preview',
      environment: 'preview',
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'vercel-preview',
      provider: 'vercel',
    });
  });

  it('refuses a production token in the staging deployment', async () => {
    const { verify, provider } = await fixture('staging');
    const token = await signToken(provider(VERCEL_ISSUER), {
      project_id: 'prj_preview',
      environment: 'production',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'environment_mismatch' });
  });

  it('refuses a project that has no policy, even on the right team', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(VERCEL_ISSUER), {
      project_id: 'prj_unknown',
      environment: 'production',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'unknown_workload' });
  });

  it('refuses a token minted for another audience', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(
      provider(VERCEL_ISSUER),
      { project_id: 'prj_acme_website', environment: 'production' },
      { audience: 'https://vercel.com/other' }
    );
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });
});

describe('Fly machine identity', () => {
  it('accepts a machine token bound to the policy org and app', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), {
      org_name: 'acme',
      app_name: 'fly-app',
      machine_id: 'machine-1',
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'fly-app',
      provider: 'fly',
    });
  });

  it('refuses an app without a policy in the same org', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(FLY_ISSUER), {
      org_name: 'acme',
      app_name: 'other-app',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'unknown_workload' });
  });

  it('refuses the default Fly audience instead of the STS issuer', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(
      provider(FLY_ISSUER),
      { org_name: 'acme', app_name: 'fly-app' },
      { audience: 'https://fly.io/acme' }
    );
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });
});

describe('GitHub Actions identity', () => {
  it('accepts a workflow token bound to repository ids and a ref', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      repository_id: '123',
      repository_owner_id: '456',
      repository: 'acme/repo',
      ref: 'refs/heads/main',
      event_name: 'push',
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'github-app',
      provider: 'github',
    });
  });

  it('refuses a workflow token from another ref of the same repository', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      repository_id: '123',
      repository_owner_id: '456',
      ref: 'refs/heads/feature',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses a token from another repository', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      repository_id: '999',
      repository_owner_id: '456',
      ref: 'refs/heads/main',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'unknown_workload' });
  });

  it('binds a deployment environment when the policy lists one', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      repository_id: '789',
      repository_owner_id: '456',
      environment: 'production',
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'github-env',
      provider: 'github',
    });
  });

  it('refuses a token without the bound environment', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      repository_id: '789',
      repository_owner_id: '456',
      ref: 'refs/heads/main',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
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
    const impostor = await createProvider(VERCEL_ISSUER, 'https://vercel.com/acme');
    const token = await signToken(impostor, {
      project_id: 'prj_acme_website',
      environment: 'production',
    });
    expect(await verify(token)).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });

  it('refuses a malformed token', async () => {
    const { verify } = await fixture('production');
    expect(await verify('not-a-jwt')).toEqual({ status: 'denied', reason: 'identity_rejected' });
  });
});

describe('JWKS caching', () => {
  it('discovers a provider once per verifier and reuses the key set', async () => {
    const { verify, calls, provider } = await fixture('production');
    const token = await signToken(provider(VERCEL_ISSUER), {
      project_id: 'prj_acme_website',
      environment: 'production',
    });
    await verify(token);
    await verify(token);
    expect(calls.get(`${VERCEL_ISSUER}/.well-known/openid-configuration`)).toBe(1);
    expect(calls.get(`${VERCEL_ISSUER}/.well-known/jwks`)).toBe(1);
  });
});
