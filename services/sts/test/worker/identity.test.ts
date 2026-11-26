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
  // Two policies on one repository, routed by GitHub environment and workflow file, plus the
  // workflow_run policy; `smoke-test.yml` is a reusable workflow `publish.yml` calls.
  'ci-release.yaml': `
workload: ci-release
environments: [production]
identity:
  kind: github-oidc
  repository: acme/repo
  repositoryId: '123'
  repositoryOwnerId: '456'
  environment: release
  jobWorkflowRefs:
    - acme/repo/.github/workflows/publish.yml@refs/heads/main
    - acme/repo/.github/workflows/smoke-test.yml@refs/heads/main
  events: [workflow_dispatch]
secrets: [APP_SECRET]
`,
  'ci-automation.yaml': `
workload: ci-automation
environments: [production]
identity:
  kind: github-oidc
  repository: acme/repo
  repositoryId: '123'
  repositoryOwnerId: '456'
  environment: automation
  jobWorkflowRefs: [acme/repo/.github/workflows/beta.yml@refs/heads/main]
  events: [push, schedule, workflow_dispatch]
secrets: [APP_SECRET]
`,
  'ci-commit.yaml': `
workload: ci-commit
environments: [production]
identity:
  kind: github-oidc
  repository: acme/repo
  repositoryId: '123'
  repositoryOwnerId: '456'
  environment: automation
  jobWorkflowRefs: [acme/repo/.github/workflows/baselines.yml@refs/heads/main]
  events: [workflow_run]
secrets: [APP_SECRET]
`,
  'ci-review.yaml': `
workload: ci-review
environments: [staging]
identity:
  kind: github-oidc
  repository: acme/other
  repositoryId: '789'
  repositoryOwnerId: '456'
  jobWorkflowRefs: [acme/other/.github/workflows/review.yml@refs/heads/main]
  events: [push]
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

const RELEASE_WORKFLOW = 'acme/repo/.github/workflows/publish.yml@refs/heads/main';

/** A `publish.yml` job in the `release` environment, with GitHub's immutable-format subject. */
const GITHUB_CLAIMS = {
  sub: 'repo:acme@456/repo@123:environment:release',
  repository_id: '123',
  repository_owner_id: '456',
  repository: 'acme/repo',
  repository_owner: 'acme',
  environment: 'release',
  ref: 'refs/heads/main',
  event_name: 'workflow_dispatch',
  job_workflow_ref: RELEASE_WORKFLOW,
  workflow_ref: RELEASE_WORKFLOW,
  run_id: '9001',
};

const AUTOMATION_CLAIMS = {
  ...GITHUB_CLAIMS,
  sub: 'repo:acme@456/repo@123:environment:automation',
  environment: 'automation',
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
      run: null,
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
  it('accepts a job of a listed workflow in the bound environment, with its exp and iat', async () => {
    const { verify, provider } = await fixture('production');
    const issuedAt = Math.floor(Date.now() / 1000);
    const token = await signToken(provider(GITHUB_ISSUER), GITHUB_CLAIMS, {
      issuedAt,
      expiresAt: issuedAt + 300,
    });
    expect(await verify(token)).toEqual({
      status: 'verified',
      workload: 'ci-release',
      provider: 'github',
      attestationExp: issuedAt + 300,
      attestationIat: issuedAt,
      run: { jobWorkflowRef: RELEASE_WORKFLOW, runId: '9001' },
    });
  });

  it('carries run_attempt for the delivery row and keeps per-run claims off a refusal', async () => {
    const { verify, provider } = await fixture('production');
    const accepted = await signToken(provider(GITHUB_ISSUER), {
      ...GITHUB_CLAIMS,
      run_attempt: '2',
    });
    expect(await verify(accepted)).toMatchObject({
      run: { jobWorkflowRef: RELEASE_WORKFLOW, runId: '9001', runAttempt: '2' },
    });
    const refused = await verify(
      await signToken(provider(GITHUB_ISSUER), {
        ...GITHUB_CLAIMS,
        run_attempt: '2',
        event_name: 'push',
      })
    );
    expect(refused).toMatchObject({ status: 'denied' });
    expect(JSON.stringify(refused)).not.toMatch(/run_id|run_attempt|9001/);
  });

  it('accepts a job of a called reusable workflow by its own entry', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      ...GITHUB_CLAIMS,
      job_workflow_ref: 'acme/repo/.github/workflows/smoke-test.yml@refs/heads/main',
    });
    expect(await verify(token)).toMatchObject({ status: 'verified', workload: 'ci-release' });
  });

  it('routes two policies on one repository by environment and workflow file', async () => {
    const { verify, provider } = await fixture('production');
    const beta = await signToken(provider(GITHUB_ISSUER), {
      ...AUTOMATION_CLAIMS,
      event_name: 'schedule',
      job_workflow_ref: 'acme/repo/.github/workflows/beta.yml@refs/heads/main',
    });
    expect(await verify(beta)).toMatchObject({ status: 'verified', workload: 'ci-automation' });
    const commit = await signToken(provider(GITHUB_ISSUER), {
      ...AUTOMATION_CLAIMS,
      event_name: 'workflow_run',
      job_workflow_ref: 'acme/repo/.github/workflows/baselines.yml@refs/heads/main',
    });
    expect(await verify(commit)).toMatchObject({ status: 'verified', workload: 'ci-commit' });
  });

  it.each([
    ['an unlisted workflow file', 'acme/repo/.github/workflows/other.yml@refs/heads/main'],
    ['a listed workflow file on another ref', `${RELEASE_WORKFLOW.split('@')[0]}@refs/heads/x`],
    ["another environment's workflow file", 'acme/repo/.github/workflows/beta.yml@refs/heads/main'],
  ])('refuses a job of %s and names the repository', async (_case, workflow) => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      ...GITHUB_CLAIMS,
      job_workflow_ref: workflow,
    });
    expect(await verify(token)).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
      subject: { actor: 'github:123', claims: { job_workflow_ref: workflow } },
    });
  });

  it('refuses a token without the bound GitHub environment', async () => {
    const { verify, provider } = await fixture('production');
    const withoutEnvironment: Record<string, string> = {
      ...GITHUB_CLAIMS,
      sub: 'repo:acme@456/repo@123:ref:refs/heads/main',
    };
    delete withoutEnvironment.environment;
    const token = await signToken(provider(GITHUB_ISSUER), withoutEnvironment);
    expect(await verify(token)).toMatchObject({ status: 'denied', reason: 'identity_rejected' });
  });

  it.each([
    [
      'the name-only subject of a repository without immutable subjects',
      'repo:acme/repo:environment:release',
    ],
    ['the ref form', 'repo:acme@456/repo@123:ref:refs/heads/main'],
    ['another owner id', 'repo:acme@999/repo@123:environment:release'],
    ['another environment', 'repo:acme@456/repo@123:environment:automation'],
    ['a wildcard', 'repo:acme@456/repo@123:environment:*'],
  ])('refuses a subject that is not the exact one: %s', async (_case, sub) => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), { ...GITHUB_CLAIMS, sub });
    expect(await verify(token)).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
      subject: { actor: 'ci-release', claims: { sub } },
    });
  });

  it('refuses a ref the policy does not list', async () => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), {
      ...GITHUB_CLAIMS,
      ref: 'refs/heads/feature',
    });
    expect(await verify(token)).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
      subject: { actor: 'ci-release' },
    });
  });

  it.each([
    'pull_request_target',
    'pull_request',
    'issues',
    'issue_comment',
    'workflow_run',
    'push',
  ])('refuses a %s token that the policy events do not list', async event => {
    const { verify, provider } = await fixture('production');
    const token = await signToken(provider(GITHUB_ISSUER), { ...GITHUB_CLAIMS, event_name: event });
    expect(await verify(token)).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
      subject: { actor: 'ci-release', claims: { event_name: event } },
    });
  });

  it('accepts workflow_run only for the policy that lists it', async () => {
    const { verify, provider } = await fixture('production');
    const baselines = 'acme/repo/.github/workflows/baselines.yml@refs/heads/main';
    const push = await signToken(provider(GITHUB_ISSUER), {
      ...AUTOMATION_CLAIMS,
      event_name: 'push',
      job_workflow_ref: baselines,
    });
    expect(await verify(push)).toMatchObject({
      reason: 'identity_rejected',
      subject: { actor: 'ci-commit' },
    });
    const beta = await signToken(provider(GITHUB_ISSUER), {
      ...AUTOMATION_CLAIMS,
      event_name: 'workflow_run',
      job_workflow_ref: 'acme/repo/.github/workflows/beta.yml@refs/heads/main',
    });
    expect(await verify(beta)).toMatchObject({
      reason: 'identity_rejected',
      subject: { actor: 'ci-automation' },
    });
  });

  it('binds the ref form of the subject for a policy without an environment', async () => {
    const { verify, provider } = await fixture('staging');
    const review = {
      sub: 'repo:acme@456/other@789:ref:refs/heads/main',
      repository_id: '789',
      repository_owner_id: '456',
      ref: 'refs/heads/main',
      event_name: 'push',
      job_workflow_ref: 'acme/other/.github/workflows/review.yml@refs/heads/main',
    };
    expect(await verify(await signToken(provider(GITHUB_ISSUER), review))).toMatchObject({
      status: 'verified',
      workload: 'ci-review',
    });
    const withEnvironment = await signToken(provider(GITHUB_ISSUER), {
      ...review,
      sub: 'repo:acme@456/other@789:environment:staging',
      environment: 'staging',
    });
    expect(await verify(withEnvironment)).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
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
          environment: 'release',
          ref: 'refs/heads/main',
          event_name: 'workflow_dispatch',
          job_workflow_ref: RELEASE_WORKFLOW,
          sub: 'repo:acme@456/repo@123:environment:release',
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
      subject: { actor: 'ci-release' },
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
