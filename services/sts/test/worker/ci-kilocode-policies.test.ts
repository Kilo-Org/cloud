import { describe, expect, it } from 'vitest';
import { IdentityVerifier, type VerifyOutcome } from '../../src/identity/verify';
import { policyIndex } from '../../src/policy';
import { loadPolicies } from '../../src/policy/load';
import { bundleFolder } from '../../src/policy/schema';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';

// The shipped Kilo-Org/kilocode policies (kilocode CI design 6), checked against the exact GitHub
// Actions identities their workflows present.
const STS_ISSUER = 'https://sts.test';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const REPOSITORY_ID = '946087422';
const OWNER_ID = '201822503';
const WORKFLOWS = 'Kilo-Org/kilocode/.github/workflows';
const MAIN = 'refs/heads/main';
const V2 = 'refs/heads/v2';

type Expected = {
  workload: string;
  environment: string;
  /** The one ref the policy accepts; every workflow file is pinned to it. */
  ref: string;
  workflows: string[];
  events: string[];
  secrets: string[];
};

const EXPECTED: Expected[] = [
  {
    workload: 'ci-kilocode-release',
    environment: 'release',
    ref: MAIN,
    workflows: ['publish.yml'],
    events: ['workflow_dispatch'],
    secrets: ['KILOCODE_ANACONDA_API_KEY', 'KILOCODE_AUR_KEY', 'KILOCODE_MAINTAINER_APP_KEY'],
  },
  {
    workload: 'ci-kilocode-release-jetbrains',
    environment: 'release-jetbrains',
    ref: MAIN,
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
    ref: MAIN,
    workflows: ['nix-hashes.yml', 'prepare-jetbrains-release.yml'],
    events: ['push', 'workflow_dispatch'],
    secrets: ['KILOCODE_MAINTAINER_APP_KEY'],
  },
  {
    workload: 'ci-kilocode-app-key-v2',
    environment: 'automation',
    ref: V2,
    workflows: ['kilo-v2.yml'],
    events: ['push'],
    secrets: ['KILOCODE_MAINTAINER_APP_KEY'],
  },
  {
    workload: 'ci-kilocode-scan-notify',
    environment: 'automation',
    ref: MAIN,
    workflows: ['security-findings-notify.yml'],
    events: ['schedule', 'workflow_dispatch'],
    secrets: ['KILOCODE_MAINTAINER_APP_KEY', 'KILOCODE_SECURITY_ALERTS_SLACK_WEBHOOK'],
  },
  {
    workload: 'ci-kilocode-community',
    environment: 'automation',
    ref: MAIN,
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
    ref: MAIN,
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
    ref: MAIN,
    workflows: ['watch-opencode-releases.yml'],
    events: ['schedule', 'workflow_dispatch'],
    secrets: ['KILOCODE_OPENCODE_WATCH_SLACK_WEBHOOK'],
  },
];

const pinned = (file: string, ref = MAIN) => `${WORKFLOWS}/${file}@${ref}`;

function claims(
  environment: string,
  file: string,
  event: string,
  ref = MAIN
): Record<string, string> {
  return {
    sub: `repo:Kilo-Org@${OWNER_ID}/kilocode@${REPOSITORY_ID}:environment:${environment}`,
    repository_id: REPOSITORY_ID,
    repository_owner_id: OWNER_ID,
    repository: 'Kilo-Org/kilocode',
    repository_owner: 'Kilo-Org',
    environment,
    ref,
    event_name: event,
    job_workflow_ref: pinned(file, ref),
    workflow_ref: pinned(file, ref),
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
          refs: [expected.ref],
          jobWorkflowRefs: expected.workflows.map(file => pinned(file, expected.ref)),
          events: expected.events,
          legacySubject: true,
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
    expect(await verify(claims(policy.environment, file, event, policy.ref))).toMatchObject({
      status: 'verified',
      workload,
      provider: 'github',
      run: { jobWorkflowRef: pinned(file, policy.ref), runId: '4242' },
    });
  });

  it.each(cases)('refuses %s for %s on another ref', async (workload, file, event, policy) => {
    const { verify } = await fixture('production');
    const otherRefs = [MAIN, V2, 'refs/heads/feature', 'refs/tags/v1.0.0'].filter(
      ref => ref !== policy.ref
    );
    for (const ref of otherRefs) {
      // The token's own ref, with the workflow file at that ref and at the policy's ref.
      for (const jobWorkflowRef of [pinned(file, ref), pinned(file, policy.ref)]) {
        const outcome = await verify({
          ...claims(policy.environment, file, event, policy.ref),
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
        expect(
          await verify(claims(policy.environment, file, event, policy.ref)),
          event
        ).toMatchObject({
          status: 'denied',
          reason: 'identity_rejected',
          subject: { actor: workload, claims: { event_name: event } },
        });
      }
    }
  );

  it.each(EXPECTED)('refuses an unlisted workflow in $environment', async policy => {
    const { verify } = await fixture('production');
    for (const file of [
      'ci.yml',
      'docs-sync.yml',
      'smoke-test.yml',
      'disabled/beta.yml',
      'kilo-v2.yml',
      'nix-hashes.yml',
    ]) {
      if (policy.workflows.includes(file)) continue;
      const event = policy.events[0] ?? 'workflow_dispatch';
      const body = claims(policy.environment, 'x.yml', event, policy.ref);
      body.job_workflow_ref = pinned(file, policy.ref);
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
        const outcome = await verify(claims(environment, file, event, policy.ref));
        expect(outcome, `${policy.workload} in ${environment}`).toMatchObject({
          status: 'denied',
          reason: 'identity_rejected',
        });
      }
    }
  });

  it('refuses another repository, another owner, and subjects naming another repository', async () => {
    const { verify } = await fixture('production');
    const base = claims('release', 'publish.yml', 'workflow_dispatch');
    // Kilo-Org/bouncer's repository id, with every other claim unchanged. Bouncer has its own
    // workload (ci-deploy-bouncer), so the claims match it and its identity check refuses them.
    expect(await verify({ ...base, repository_id: '1395255492' })).toMatchObject({
      status: 'denied',
      reason: 'identity_rejected',
    });
    expect(await verify({ ...base, repository_owner_id: '1' })).toMatchObject({
      status: 'denied',
      reason: 'unknown_workload',
    });
    // The subject names another repository while the id claims still name kilocode.
    for (const sub of [
      `repo:Kilo-Org@${OWNER_ID}/kilocode@1395255492:environment:release`,
      `repo:Kilo-Org@${OWNER_ID}/bouncer@1395255492:environment:release`,
      'repo:Kilo-Org/bouncer:environment:release',
      'repo:Kilo-Org/kilocode:environment:automation',
      'repo:Kilo-Org/kilocode:ref:refs/heads/main',
      'repo:Kilo-Org/kilocode:pull_request',
    ]) {
      expect(await verify({ ...base, sub }), sub).toMatchObject({
        status: 'denied',
        reason: 'identity_rejected',
        subject: { actor: 'ci-kilocode-release' },
      });
    }
  });

  // Kilo-Org/kilocode keeps GitHub's default subject until npm/cli#9969 is fixed (legacySubject).
  describe('the default subject kilocode issues today', () => {
    const LEGACY = 'repo:Kilo-Org/kilocode:environment:release';

    it.each(cases)('issues %s for %s on %s', async (workload, file, event, policy) => {
      const { verify } = await fixture('production');
      const body = {
        ...claims(policy.environment, file, event, policy.ref),
        sub: `repo:Kilo-Org/kilocode:environment:${policy.environment}`,
      };
      expect(await verify(body)).toMatchObject({ status: 'verified', workload });
    });

    it('refuses it with another repository id or owner id', async () => {
      const { verify } = await fixture('production');
      const base = { ...claims('release', 'publish.yml', 'workflow_dispatch'), sub: LEGACY };
      // 999999999 is a repository id that no shipped policy holds. Bouncer's id has its own
      // workload; the case above covers it.
      const changes: Record<string, string>[] = [
        { repository_id: '999999999' },
        { repository_owner_id: '1' },
        { repository_id: '999999999', repository_owner_id: '1' },
      ];
      for (const ids of changes) {
        const outcome = await verify({ ...base, ...ids });
        expect(outcome, JSON.stringify(ids)).toMatchObject({
          status: 'denied',
          reason: 'unknown_workload',
        });
        expect(outcome).not.toMatchObject({ workload: 'ci-kilocode-release' });
      }
    });

    it('keeps every other binding', async () => {
      const { verify } = await fixture('production');
      const base = { ...claims('release', 'publish.yml', 'workflow_dispatch'), sub: LEGACY };
      const changes: Record<string, string>[] = [
        { ref: 'refs/heads/v2', job_workflow_ref: pinned('publish.yml', 'refs/heads/v2') },
        { event_name: 'push' },
        { job_workflow_ref: pinned('ci.yml') },
        { environment: 'automation' },
      ];
      for (const change of changes) {
        expect(await verify({ ...base, ...change }), JSON.stringify(change)).toMatchObject({
          status: 'denied',
          reason: 'identity_rejected',
        });
      }
    });

    it('accepts the ref form on a kilocode policy without an environment, and only with its ids', async () => {
      // A test policy with kilocode's ids and no GitHub environment (staging, which allows that).
      const policies = loadPolicies({
        'ci-kilocode-ref.yaml': `
workload: ci-kilocode-ref
environments: [staging]
identity:
  kind: github-oidc
  repository: Kilo-Org/kilocode
  repositoryId: '${REPOSITORY_ID}'
  repositoryOwnerId: '${OWNER_ID}'
  legacySubject: true
  jobWorkflowRefs: [${pinned('nightly.yml')}]
  events: [schedule]
secrets: [APP_SECRET]
`,
      });
      const github = await createProvider(GITHUB_ISSUER, STS_ISSUER);
      const verifier = new IdentityVerifier({
        policies: policies.all(),
        environment: 'staging',
        audience: STS_ISSUER,
        fetch: providerFetch([github]).fetch,
      });
      const { environment: _environment, ...base } = claims('', 'nightly.yml', 'schedule');
      const body = { ...base, sub: 'repo:Kilo-Org/kilocode:ref:refs/heads/main' };
      expect(await verifier.verify(await signToken(github, body))).toMatchObject({
        status: 'verified',
        workload: 'ci-kilocode-ref',
      });
      const changes: Record<string, string>[] = [
        { repository_id: '1395255492' },
        { repository_owner_id: '1' },
      ];
      for (const ids of changes) {
        expect(
          await verifier.verify(await signToken(github, { ...body, ...ids })),
          JSON.stringify(ids)
        ).toMatchObject({ status: 'denied', reason: 'unknown_workload' });
      }
    });
  });

  // Manager ruling M76: the v2 progress-commit job, pinned to the repository ids, the job workflow
  // ref kilo-v2.yml@refs/heads/v2, the ref refs/heads/v2 and the environment automation.
  describe('ci-kilocode-app-key-v2', () => {
    const JOB = pinned('kilo-v2.yml', V2);
    const v2Claims = claims('automation', 'kilo-v2.yml', 'push', V2);

    it('issues only KILOCODE_MAINTAINER_APP_KEY to the progress-commit job, with either subject', async () => {
      expect(policyIndex.get('production', 'ci-kilocode-app-key-v2')?.secrets).toEqual([
        'KILOCODE_MAINTAINER_APP_KEY',
      ]);
      const { verify } = await fixture('production');
      for (const sub of [v2Claims.sub, 'repo:Kilo-Org/kilocode:environment:automation']) {
        expect(await verify({ ...v2Claims, sub }), sub).toMatchObject({
          status: 'verified',
          workload: 'ci-kilocode-app-key-v2',
          run: { jobWorkflowRef: JOB },
        });
      }
    });

    it('leaves ci-kilocode-app-key on main only', () => {
      expect(policyIndex.get('production', 'ci-kilocode-app-key')?.identity).toMatchObject({
        environment: 'automation',
        refs: [MAIN],
        jobWorkflowRefs: [pinned('nix-hashes.yml'), pinned('prepare-jetbrains-release.yml')],
        events: ['push', 'workflow_dispatch'],
      });
    });

    it('refuses every other workflow file on refs/heads/v2 in automation', async () => {
      const { verify } = await fixture('production');
      for (const file of [
        'nix-hashes.yml',
        'prepare-jetbrains-release.yml',
        'security-findings-notify.yml',
        'publish.yml',
        'ci.yml',
        'kilo.yml',
        'kilo-v1.yml',
        'kilo-v3.yml',
      ]) {
        for (const event of ['push', 'workflow_dispatch']) {
          const outcome = await verify({
            ...v2Claims,
            event_name: event,
            job_workflow_ref: pinned(file, V2),
            workflow_ref: pinned(file, V2),
          });
          expect(outcome, `${file} ${event}`).toMatchObject({
            status: 'denied',
            reason: 'identity_rejected',
          });
          expect(outcome).not.toMatchObject({ workload: 'ci-kilocode-app-key-v2' });
        }
      }
    });

    it('matches the job workflow ref exactly, with no prefix, suffix, case change or glob', async () => {
      const { verify } = await fixture('production');
      for (const jobWorkflowRef of [
        `${WORKFLOWS}/kilo-v2.yml`,
        `${WORKFLOWS}/kilo-v2.yml@`,
        `${WORKFLOWS}/kilo-v2.yml@refs/heads/v`,
        `${WORKFLOWS}/kilo-v2.yml@refs/heads/v2 `,
        `${WORKFLOWS}/kilo-v2.yml@refs/heads/v2x`,
        `${WORKFLOWS}/kilo-v2.yml@refs/heads/v2/extra`,
        `${WORKFLOWS}/kilo-v2.yml.bak@refs/heads/v2`,
        `${WORKFLOWS}/kilo-v2.yaml@refs/heads/v2`,
        `${WORKFLOWS}/Kilo-v2.yml@refs/heads/v2`,
        `${WORKFLOWS}/x-kilo-v2.yml@refs/heads/v2`,
        `${WORKFLOWS}/sub/kilo-v2.yml@refs/heads/v2`,
        `${WORKFLOWS}/kilo-v2*.yml@refs/heads/v2`,
        `${WORKFLOWS}/*.yml@refs/heads/v2`,
        `${WORKFLOWS}/*@refs/heads/v2`,
        `${WORKFLOWS}/kilo-v2.yml@refs/heads/*`,
        `${WORKFLOWS}/kilo-v2.yml@*`,
        `kilo-org/kilocode/.github/workflows/kilo-v2.yml@refs/heads/v2`,
        `Kilo-Org/kilocode-fork/.github/workflows/kilo-v2.yml@refs/heads/v2`,
        `Kilo-Org/kilocode/.github/workflows/../workflows/kilo-v2.yml@refs/heads/v2`,
        `x${JOB}`,
        `${JOB}x`,
      ]) {
        expect(jobWorkflowRef).not.toBe(JOB);
        const outcome = await verify({
          ...v2Claims,
          job_workflow_ref: jobWorkflowRef,
          workflow_ref: jobWorkflowRef,
        });
        expect(outcome, jobWorkflowRef).toMatchObject({ status: 'denied' });
        expect(outcome).not.toMatchObject({ workload: 'ci-kilocode-app-key-v2' });
      }
    });

    it('refuses main, other branches, tags and pull request refs', async () => {
      const { verify } = await fixture('production');
      for (const ref of [
        MAIN,
        'refs/heads/v',
        'refs/heads/v2x',
        'refs/heads/v2/feature',
        'refs/heads/feature',
        'refs/tags/v2',
        'refs/pull/1/merge',
      ]) {
        // The job workflow at the token's own ref, and at v2 with the token's ref elsewhere.
        for (const jobWorkflowRef of [pinned('kilo-v2.yml', ref), JOB]) {
          const outcome = await verify({ ...v2Claims, ref, job_workflow_ref: jobWorkflowRef });
          expect(outcome, `${ref} ${jobWorkflowRef}`).toMatchObject({
            status: 'denied',
            reason: 'identity_rejected',
          });
          expect(outcome).not.toMatchObject({ workload: 'ci-kilocode-app-key-v2' });
        }
      }
    });

    it('refuses other GitHub environments and a job without one', async () => {
      const { verify } = await fixture('production');
      for (const environment of ['release', 'release-jetbrains', 'release-v2', 'agent', 'v2']) {
        const outcome = await verify(claims(environment, 'kilo-v2.yml', 'push', V2));
        expect(outcome, environment).toMatchObject({
          status: 'denied',
          reason: 'identity_rejected',
        });
        expect(outcome).not.toMatchObject({ workload: 'ci-kilocode-app-key-v2' });
      }
      const { environment: _environment, ...withoutEnvironment } = v2Claims;
      for (const sub of [
        `repo:Kilo-Org@${OWNER_ID}/kilocode@${REPOSITORY_ID}:ref:${V2}`,
        `repo:Kilo-Org/kilocode:ref:${V2}`,
      ]) {
        const outcome = await verify({ ...withoutEnvironment, sub });
        expect(outcome, sub).toMatchObject({ status: 'denied', reason: 'identity_rejected' });
        expect(outcome).not.toMatchObject({ workload: 'ci-kilocode-app-key-v2' });
      }
    });
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
