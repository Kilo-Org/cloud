import { describe, expect, it } from 'vitest';
import { IdentityVerifier, type VerifyOutcome } from '../../src/identity/verify';
import { policyIndex } from '../../src/policy';
import { bundleFolder } from '../../src/policy/schema';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';

// The shipped Kilo-Org/kilocode policies (kilocode CI design 6), checked against the exact GitHub
// Actions identities their workflows present.
const STS_ISSUER = 'https://sts.test';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const REPOSITORY_ID = '946087422';
const OWNER_ID = '201822503';
const WORKFLOWS = 'Kilo-Org/kilocode/.github/workflows';

type Expected = {
  workload: string;
  environment: string;
  workflows: string[];
  events: string[];
  secrets: string[];
};

const EXPECTED: Expected[] = [
  {
    workload: 'ci-kilocode-release',
    environment: 'release',
    workflows: ['publish.yml'],
    events: ['workflow_dispatch'],
    secrets: ['KILOCODE_ANACONDA_API_KEY', 'KILOCODE_AUR_KEY', 'KILOCODE_MAINTAINER_APP_KEY'],
  },
  {
    workload: 'ci-kilocode-release-jetbrains',
    environment: 'release-jetbrains',
    workflows: ['publish-jetbrains.yml', 'publish-jetbrains-bundled.yml'],
    events: ['workflow_dispatch'],
    secrets: [
      'KILOCODE_JETBRAINS_MARKETPLACE_TOKEN',
      'KILOCODE_JETBRAINS_PRIVATE_KEY',
      'KILOCODE_JETBRAINS_PRIVATE_KEY_PASSWORD',
      'KILOCODE_JETBRAINS_CERTIFICATE_CHAIN',
    ],
  },
  {
    workload: 'ci-kilocode-app-key',
    environment: 'automation',
    workflows: ['nix-hashes.yml', 'prepare-jetbrains-release.yml'],
    events: ['push', 'workflow_dispatch'],
    secrets: ['KILOCODE_MAINTAINER_APP_KEY'],
  },
  {
    workload: 'ci-kilocode-scan-notify',
    environment: 'automation',
    workflows: ['security-findings-notify.yml'],
    events: ['schedule', 'workflow_dispatch'],
    secrets: ['KILOCODE_MAINTAINER_APP_KEY', 'KILOCODE_SECURITY_ALERTS_SLACK_WEBHOOK'],
  },
  {
    workload: 'ci-kilocode-community',
    environment: 'automation',
    workflows: ['community-sweep.yml'],
    events: ['schedule', 'workflow_dispatch'],
    secrets: [
      'KILOCODE_MAINTAINER_APP_KEY',
      'KILOCODE_COMMUNITY_TRIAGE_SLACK_TOKEN',
      'KILOCODE_COMMUNITY_TRIAGE_SLACK_WEBHOOK',
    ],
  },
  {
    workload: 'ci-kilocode-notify',
    environment: 'automation',
    workflows: [
      'outdated-kilo-deps.yml',
      'stale-alerts-report.yml',
      'stale-bot-pr-notify.yml',
      'v2-upstream-release-notify.yml',
    ],
    events: ['schedule', 'workflow_dispatch'],
    secrets: ['KILOCODE_SECURITY_ALERTS_SLACK_WEBHOOK', 'KILOCODE_V2_SYNC_SLACK_WEBHOOK'],
  },
  {
    workload: 'ci-kilocode-opencode-watch',
    environment: 'automation',
    workflows: ['watch-opencode-releases.yml'],
    events: ['schedule', 'workflow_dispatch'],
    secrets: ['KILOCODE_OPENCODE_WATCH_SLACK_WEBHOOK'],
  },
];

const pinned = (file: string, ref = 'refs/heads/main') => `${WORKFLOWS}/${file}@${ref}`;

function claims(environment: string, file: string, event: string): Record<string, string> {
  return {
    sub: `repo:Kilo-Org@${OWNER_ID}/kilocode@${REPOSITORY_ID}:environment:${environment}`,
    repository_id: REPOSITORY_ID,
    repository_owner_id: OWNER_ID,
    repository: 'Kilo-Org/kilocode',
    repository_owner: 'Kilo-Org',
    environment,
    ref: 'refs/heads/main',
    event_name: event,
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
    issuer: STS_ISSUER,
    fetch: providerFetch([github]).fetch,
  });
  return { verify: async body => verifier.verify(await signToken(github, body)) };
}

const cases = EXPECTED.flatMap(policy =>
  policy.workflows.flatMap(file =>
    policy.events.map(event => [policy.workload, file, event, policy] as const)
  )
);

describe('shipped Kilo-Org/kilocode policies', () => {
  it('load with exactly the requested identity and secrets, production only, bundles in /ci', () => {
    const shipped = policyIndex
      .all()
      .filter(policy => policy.identity.kind === 'github-oidc')
      .filter(policy => policy.workload.startsWith('ci-kilocode-'));
    expect(shipped.map(policy => policy.workload).sort()).toEqual(
      EXPECTED.map(policy => policy.workload).sort()
    );
    for (const expected of EXPECTED) {
      const policy = policyIndex.get('production', expected.workload);
      expect(policy, expected.workload).toMatchObject({
        workload: expected.workload,
        environments: ['production'],
        secrets: expected.secrets,
        audiences: [],
        scopes: [],
        identity: {
          kind: 'github-oidc',
          repository: 'Kilo-Org/kilocode',
          repositoryId: REPOSITORY_ID,
          repositoryOwnerId: OWNER_ID,
          environment: expected.environment,
          refs: ['refs/heads/main'],
          jobWorkflowRefs: expected.workflows.map(file => pinned(file)),
          events: expected.events,
        },
      });
      expect(policy?.dynamic ?? [], expected.workload).toEqual([]);
      expect(policyIndex.get('staging', expected.workload)).toBeNull();
      expect(policyIndex.get('development', expected.workload)).toBeNull();
      if (policy === null) throw new Error(`${expected.workload} is not served in production`);
      expect(bundleFolder(policy)).toEqual({ root: '/ci', path: `/ci/${expected.workload}` });
    }
  });

  it.each(cases)('issues %s for %s on %s', async (workload, file, event, policy) => {
    const { verify } = await fixture('production');
    expect(await verify(claims(policy.environment, file, event))).toMatchObject({
      status: 'verified',
      workload,
      provider: 'github',
      run: { jobWorkflowRef: pinned(file), runId: '4242' },
    });
  });

  it.each(cases)('refuses %s for %s on another ref', async (workload, file, event, policy) => {
    const { verify } = await fixture('production');
    for (const ref of ['refs/heads/v2', 'refs/heads/feature', 'refs/tags/v1.0.0']) {
      // The token's own ref, with the workflow file at that ref and at main.
      for (const jobWorkflowRef of [pinned(file, ref), pinned(file)]) {
        const outcome = await verify({
          ...claims(policy.environment, file, event),
          ref,
          job_workflow_ref: jobWorkflowRef,
        });
        expect(outcome, `${ref} ${jobWorkflowRef}`).toMatchObject({
          status: 'denied',
          reason: 'identity_rejected',
        });
        expect(outcome).not.toMatchObject({ workload });
      }
    }
  });

  it.each(cases)(
    'refuses %s for %s on an unlisted event',
    async (workload, file, _event, policy) => {
      const { verify } = await fixture('production');
      const unlisted = [
        'push',
        'schedule',
        'workflow_dispatch',
        'workflow_run',
        'pull_request',
        'pull_request_target',
        'issues',
        'issue_comment',
        'merge_group',
        'workflow_call',
      ].filter(event => !policy.events.includes(event));
      expect(unlisted.length).toBeGreaterThan(0);
      for (const event of unlisted) {
        expect(await verify(claims(policy.environment, file, event)), event).toMatchObject({
          status: 'denied',
          reason: 'identity_rejected',
          subject: { actor: workload, claims: { event_name: event } },
        });
      }
    }
  );

  it.each(EXPECTED)('refuses an unlisted workflow in $environment', async policy => {
    const { verify } = await fixture('production');
    for (const file of ['ci.yml', 'docs-sync.yml', 'smoke-test.yml', 'disabled/beta.yml']) {
      if (policy.workflows.includes(file)) continue;
      const body = claims(policy.environment, 'x.yml', policy.events[0] ?? 'workflow_dispatch');
      body.job_workflow_ref = pinned(file);
      expect(await verify(body), file).toMatchObject({
        status: 'denied',
        reason: 'identity_rejected',
      });
    }
  });

  it('refuses a listed workflow from another GitHub environment', async () => {
    const { verify } = await fixture('production');
    for (const policy of EXPECTED) {
      for (const environment of ['release', 'release-jetbrains', 'automation', 'agent']) {
        if (environment === policy.environment) continue;
        const file = policy.workflows[0] ?? '';
        const event = policy.events[0] ?? '';
        const outcome = await verify(claims(environment, file, event));
        expect(outcome, `${policy.workload} in ${environment}`).toMatchObject({
          status: 'denied',
          reason: 'identity_rejected',
        });
      }
    }
  });

  it('refuses another repository, another owner, and the subject forms kilocode issues today', async () => {
    const { verify } = await fixture('production');
    const base = claims('release', 'publish.yml', 'workflow_dispatch');
    // Kilo-Org/bouncer's repository id, with every other claim unchanged.
    expect(await verify({ ...base, repository_id: '1395255492' })).toMatchObject({
      status: 'denied',
      reason: 'unknown_workload',
    });
    expect(await verify({ ...base, repository_owner_id: '1' })).toMatchObject({
      status: 'denied',
      reason: 'unknown_workload',
    });
    // Kilo-Org/kilocode has not opted in to immutable subjects (use_immutable_subject false on
    // 2026-11-26), so its tokens carry the name-only form, which STS refuses.
    for (const sub of [
      'repo:Kilo-Org/kilocode:environment:release',
      `repo:Kilo-Org@${OWNER_ID}/kilocode@${REPOSITORY_ID}:ref:refs/heads/main`,
    ]) {
      expect(await verify({ ...base, sub }), sub).toMatchObject({
        status: 'denied',
        reason: 'identity_rejected',
        subject: { actor: 'ci-kilocode-release' },
      });
    }
    // The subject names another repository id while the id claims still name kilocode.
    for (const sub of [
      `repo:Kilo-Org@${OWNER_ID}/kilocode@1395255492:environment:release`,
      `repo:Kilo-Org@${OWNER_ID}/bouncer@1395255492:environment:release`,
    ]) {
      expect(await verify({ ...base, sub }), sub).toMatchObject({
        status: 'denied',
        reason: 'identity_rejected',
        subject: { actor: 'ci-kilocode-release' },
      });
    }
  });

  it.each(['staging', 'development'] as const)(
    'serves none of them from %s STS',
    async environment => {
      const { verify } = await fixture(environment);
      expect(await verify(claims('release', 'publish.yml', 'workflow_dispatch'))).toMatchObject({
        status: 'denied',
        reason: 'environment_mismatch',
      });
    }
  );
});
