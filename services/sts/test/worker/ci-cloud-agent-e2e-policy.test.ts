import { describe, expect, it } from 'vitest';
import { resolveWorkloadSecrets } from '../../src/bundle/resolve';
import { IdentityVerifier, type VerifyOutcome } from '../../src/identity/verify';
import { policyIndex } from '../../src/policy';
import { bundleFolder } from '../../src/policy/schema';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';

// The shipped ci-cloud-agent-e2e policy (D35/D39, M83), checked against the exact GitHub Actions
// identity the Cloud Agent e2e tests job in cloud-agent-e2e.yml presents.
const STS_ISSUER = 'https://sts.test';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const WORKLOAD = 'ci-cloud-agent-e2e';
const REPOSITORY_ID = '1145038391';
const OWNER_ID = '201822503';
const ENVIRONMENT = 'cloud-agent-e2e';
const WORKFLOWS = 'Kilo-Org/cloud/.github/workflows';
const FILE = 'cloud-agent-e2e.yml';
const SECRETS = ['E2E_ACCESS_CLIENT_ID', 'E2E_ACCESS_CLIENT_SECRET'];

const pinned = (file: string, ref = 'refs/heads/main') => `${WORKFLOWS}/${file}@${ref}`;

function claims(
  overrides: { file?: string; environment?: string; event?: string } = {}
): Record<string, string> {
  const environment = overrides.environment ?? ENVIRONMENT;
  const file = overrides.file ?? FILE;
  return {
    sub: `repo:Kilo-Org@${OWNER_ID}/cloud@${REPOSITORY_ID}:environment:${environment}`,
    repository_id: REPOSITORY_ID,
    repository_owner_id: OWNER_ID,
    repository: 'Kilo-Org/cloud',
    repository_owner: 'Kilo-Org',
    environment,
    ref: 'refs/heads/main',
    event_name: overrides.event ?? 'workflow_dispatch',
    job_workflow_ref: pinned(file),
    workflow_ref: pinned(file),
    run_id: '4242',
  };
}

async function fixture(environment: 'production' | 'staging' | 'development'): Promise<{
  verify: (claims: Record<string, string>) => Promise<VerifyOutcome>;
}> {
  const github: TestProvider = await createProvider(GITHUB_ISSUER, STS_ISSUER);
  const verifier = new IdentityVerifier({
    policies: policyIndex.all(),
    environment,
    audience: STS_ISSUER,
    fetch: providerFetch([github]).fetch,
  });
  return { verify: async body => verifier.verify(await signToken(github, body)) };
}

const REJECTED = { status: 'denied', reason: 'identity_rejected' } as const;

describe('shipped ci-cloud-agent-e2e policy', () => {
  it('loads with exactly the pinned identity and the two Access secrets, production only, bundle in /ci', () => {
    const policy = policyIndex.get('production', WORKLOAD);
    expect(policy).toMatchObject({
      workload: WORKLOAD,
      environments: ['production'],
      audiences: [],
      scopes: [],
      identity: {
        kind: 'github-oidc',
        repository: 'Kilo-Org/cloud',
        repositoryId: REPOSITORY_ID,
        repositoryOwnerId: OWNER_ID,
        environment: ENVIRONMENT,
        refs: ['refs/heads/main'],
        jobWorkflowRefs: [pinned(FILE)],
        events: ['workflow_dispatch'],
      },
    });
    if (policy === null) throw new Error(`${WORKLOAD} is not served in production`);
    expect(policy.secrets).toEqual(SECRETS);
    expect(policy.identity).not.toHaveProperty('legacySubject');
    expect(policy.dynamic).toEqual([]);
    expect(policy.environmentGrants).toEqual({});
    expect(bundleFolder(policy)).toEqual({ root: '/ci', path: `/ci/${WORKLOAD}` });
    expect(policyIndex.get('staging', WORKLOAD)).toBeNull();
    expect(policyIndex.get('development', WORKLOAD)).toBeNull();
  });

  it('serves only the two Access names, from /ci/ci-cloud-agent-e2e', () => {
    const policy = policyIndex.get('production', WORKLOAD);
    if (policy === null) throw new Error(`${WORKLOAD} is not served in production`);
    const entry = (path: string, name: string, value: string) => ({
      path,
      name,
      id: `${path}/${name}`,
      version: 1,
      value,
    });
    const own = bundleFolder(policy).path;
    const ci = {
      entries: [
        entry(own, 'E2E_ACCESS_CLIENT_ID', 'synthetic-id'),
        entry(own, 'E2E_ACCESS_CLIENT_SECRET', 'synthetic-secret'),
        entry(own, 'E2E_USER_TOKEN', 'not-granted'),
        entry(`${own}/nested`, 'FAKE_LLM_ADMIN_TOKEN', 'not-granted'),
        entry('/ci/ci-db-migrate', 'E2E_ACCESS_CLIENT_ID', 'another-workload'),
      ],
      refused: [],
    };
    const shared = {
      entries: [
        entry('/shared', 'E2E_ACCESS_CLIENT_SECRET', 'shadowed'),
        entry('/shared', 'E2E_INTERNAL_API_SECRET', 'not-granted'),
      ],
      refused: [],
    };
    const { secrets, missing } = resolveWorkloadSecrets(own, policy.secrets, ci, shared);
    expect(missing).toEqual([]);
    expect(Object.keys(secrets).sort()).toEqual(SECRETS);
    expect(secrets.E2E_ACCESS_CLIENT_ID?.value).toBe('synthetic-id');
    expect(secrets.E2E_ACCESS_CLIENT_SECRET?.value).toBe('synthetic-secret');
  });

  it('issues it to the tests job of a dispatched cloud-agent-e2e.yml run on main', async () => {
    const { verify } = await fixture('production');
    expect(await verify(claims())).toMatchObject({
      status: 'verified',
      workload: WORKLOAD,
      provider: 'github',
      run: { jobWorkflowRef: pinned(FILE), runId: '4242' },
    });
  });

  it('refuses every unlisted event', async () => {
    const { verify } = await fixture('production');
    for (const event of [
      'push',
      'schedule',
      'workflow_run',
      'workflow_call',
      'pull_request',
      'pull_request_target',
      'issues',
      'issue_comment',
      'merge_group',
    ]) {
      expect(await verify(claims({ event })), event).toMatchObject({
        ...REJECTED,
        subject: { actor: WORKLOAD, claims: { event_name: event } },
      });
    }
  });

  it('refuses every other branch or tag, with the file at that ref and at main', async () => {
    const { verify } = await fixture('production');
    for (const ref of ['refs/heads/feature', 'refs/heads/staging', 'refs/tags/v1.0.0']) {
      for (const jobWorkflowRef of [pinned(FILE, ref), pinned(FILE)]) {
        const outcome = await verify({ ...claims(), ref, job_workflow_ref: jobWorkflowRef });
        expect(outcome, `${ref} ${jobWorkflowRef}`).toMatchObject(REJECTED);
      }
    }
  });

  it('refuses ref main with the workflow file from another branch', async () => {
    const { verify } = await fixture('production');
    for (const jobWorkflowRef of [
      pinned(FILE, 'refs/heads/feature'),
      pinned(FILE, 'refs/heads/staging'),
      pinned(FILE, 'refs/tags/v1.0.0'),
    ]) {
      const outcome = await verify({ ...claims(), job_workflow_ref: jobWorkflowRef });
      expect(outcome, jobWorkflowRef).toMatchObject(REJECTED);
    }
  });

  it('refuses every other workflow file in the cloud-agent-e2e environment', async () => {
    const { verify } = await fixture('production');
    for (const file of [
      'cloud-agent-e2e-deploy.yml',
      'cloud-agent-e2e-tests.yml',
      'cloud-agent-e2e-nightly.yml',
      'deploy-production.yml',
      'ci.yml',
    ]) {
      expect(await verify(claims({ file })), file).toMatchObject(REJECTED);
    }
  });

  it('refuses the file from every other GitHub environment and from none', async () => {
    const { verify } = await fixture('production');
    for (const environment of ['production', 'staging', 'automation', 'cloud-agent-e2e-staging']) {
      expect(await verify(claims({ environment })), environment).toMatchObject(REJECTED);
    }
    const { environment: _environment, ...withoutEnvironment } = claims();
    expect(
      await verify({
        ...withoutEnvironment,
        sub: `repo:Kilo-Org@${OWNER_ID}/cloud@${REPOSITORY_ID}:ref:refs/heads/main`,
      })
    ).toMatchObject(REJECTED);
  });

  it('refuses another repository, another owner, and any other subject', async () => {
    const { verify } = await fixture('production');
    // 999999999 is a repository id no shipped policy holds.
    const changes: Record<string, string>[] = [
      { repository_id: '999999999' },
      { repository_owner_id: '1' },
      { repository_id: '999999999', repository_owner_id: '1' },
    ];
    for (const ids of changes) {
      expect(await verify({ ...claims(), ...ids }), JSON.stringify(ids)).toMatchObject({
        status: 'denied',
        reason: 'unknown_workload',
      });
    }
    // Kilo-Org/cloud issues immutable subjects, so GitHub's name-only default is refused here.
    for (const sub of [
      `repo:Kilo-Org/cloud:environment:${ENVIRONMENT}`,
      `repo:Kilo-Org@${OWNER_ID}/cloud@${REPOSITORY_ID}:environment:production`,
      `repo:Kilo-Org@${OWNER_ID}/cloud@${REPOSITORY_ID}:ref:refs/heads/main`,
      `repo:Kilo-Org@${OWNER_ID}/kilocode@946087422:environment:${ENVIRONMENT}`,
      `repo:Kilo-Org@${OWNER_ID}/cloud@${REPOSITORY_ID}:pull_request`,
    ]) {
      expect(await verify({ ...claims(), sub }), sub).toMatchObject({
        ...REJECTED,
        subject: { actor: WORKLOAD },
      });
    }
  });

  it.each(['staging', 'development'] as const)('is not served from %s STS', async environment => {
    const { verify } = await fixture(environment);
    expect(await verify(claims())).toMatchObject({
      status: 'denied',
      reason: 'environment_mismatch',
    });
  });
});
