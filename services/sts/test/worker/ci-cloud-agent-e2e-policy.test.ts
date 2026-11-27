import { describe, expect, it } from 'vitest';
import { resolveWorkloadSecrets } from '../../src/bundle/resolve';
import { IdentityVerifier, type VerifyOutcome } from '../../src/identity/verify';
import { policyIndex } from '../../src/policy';
import { bundleFolder } from '../../src/policy/schema';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';

// The shipped ci-cloud-agent-e2e policy (D35/D39, M83), checked against the exact GitHub Actions
// identities the Cloud Agent e2e deploy and tests jobs present: dispatched on their own, and
// called by the nightly workflow.
const STS_ISSUER = 'https://sts.test';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const WORKLOAD = 'ci-cloud-agent-e2e';
const REPOSITORY_ID = '1145038391';
const OWNER_ID = '201822503';
const ENVIRONMENT = 'cloud-agent-e2e';
const WORKFLOWS = 'Kilo-Org/cloud/.github/workflows';
const FILES = ['cloud-agent-e2e-deploy.yml', 'cloud-agent-e2e-tests.yml'];
const NIGHTLY = 'cloud-agent-e2e-nightly.yml';
const SECRETS = ['E2E_ACCESS_CLIENT_ID', 'E2E_ACCESS_CLIENT_SECRET'];

const pinned = (file: string, ref = 'refs/heads/main') => `${WORKFLOWS}/${file}@${ref}`;

function claims(
  file: string,
  overrides: { environment?: string; event?: string } = {}
): Record<string, string> {
  const environment = overrides.environment ?? ENVIRONMENT;
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
        jobWorkflowRefs: FILES.map(file => pinned(file)),
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

  it.each(FILES)('issues it to %s dispatched on its own', async file => {
    const { verify } = await fixture('production');
    expect(await verify(claims(file))).toMatchObject({
      status: 'verified',
      workload: WORKLOAD,
      provider: 'github',
      run: { jobWorkflowRef: pinned(file), runId: '4242' },
    });
  });

  it.each(FILES)('issues it to %s called by the dispatched nightly', async file => {
    const { verify } = await fixture('production');
    // A called workflow's job carries its own job_workflow_ref; the caller is workflow_ref.
    const body = { ...claims(file), workflow_ref: pinned(NIGHTLY) };
    expect(await verify(body)).toMatchObject({
      status: 'verified',
      workload: WORKLOAD,
      run: { jobWorkflowRef: pinned(file) },
    });
  });

  it.each(FILES)('refuses %s on every unlisted event', async file => {
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
      expect(await verify(claims(file, { event })), event).toMatchObject({
        ...REJECTED,
        subject: { actor: WORKLOAD, claims: { event_name: event } },
      });
    }
  });

  it.each(FILES)(
    'refuses %s on every other branch or tag, with the file at that ref and at main',
    async file => {
      const { verify } = await fixture('production');
      for (const ref of ['refs/heads/feature', 'refs/heads/staging', 'refs/tags/v1.0.0']) {
        for (const jobWorkflowRef of [pinned(file, ref), pinned(file)]) {
          const outcome = await verify({ ...claims(file), ref, job_workflow_ref: jobWorkflowRef });
          expect(outcome, `${ref} ${jobWorkflowRef}`).toMatchObject(REJECTED);
        }
      }
    }
  );

  it('refuses every other workflow file in the cloud-agent-e2e environment', async () => {
    const { verify } = await fixture('production');
    for (const file of [NIGHTLY, 'deploy-production.yml', 'deploy-staging.yml', 'ci.yml']) {
      expect(await verify(claims(file)), file).toMatchObject(REJECTED);
    }
  });

  it.each(FILES)('refuses %s from every other GitHub environment and from none', async file => {
    const { verify } = await fixture('production');
    for (const environment of ['production', 'staging', 'automation', 'cloud-agent-e2e-staging']) {
      expect(await verify(claims(file, { environment })), environment).toMatchObject(REJECTED);
    }
    const { environment: _environment, ...withoutEnvironment } = claims(file);
    expect(
      await verify({
        ...withoutEnvironment,
        sub: `repo:Kilo-Org@${OWNER_ID}/cloud@${REPOSITORY_ID}:ref:refs/heads/main`,
      })
    ).toMatchObject(REJECTED);
  });

  it('refuses another repository, another owner, and any other subject', async () => {
    const { verify } = await fixture('production');
    const base = claims(FILES[1] ?? '');
    // 999999999 is a repository id no shipped policy holds.
    const changes: Record<string, string>[] = [
      { repository_id: '999999999' },
      { repository_owner_id: '1' },
      { repository_id: '999999999', repository_owner_id: '1' },
    ];
    for (const ids of changes) {
      expect(await verify({ ...base, ...ids }), JSON.stringify(ids)).toMatchObject({
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
      expect(await verify({ ...base, sub }), sub).toMatchObject({
        ...REJECTED,
        subject: { actor: WORKLOAD },
      });
    }
  });

  it.each(['staging', 'development'] as const)('is not served from %s STS', async environment => {
    const { verify } = await fixture(environment);
    for (const file of FILES) {
      expect(await verify(claims(file)), file).toMatchObject({
        status: 'denied',
        reason: 'environment_mismatch',
      });
    }
  });
});
