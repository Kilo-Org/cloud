import { describe, expect, it } from 'vitest';
import { IdentityVerifier, type VerifyOutcome } from '../../src/identity/verify';
import { policyIndex } from '../../src/policy';
import { loadPolicies } from '../../src/policy/load';
import { bundleFolder, D53_M112_CI_BUNDLE_CARVE_OUT } from '../../src/policy/schema';
import { CLOUD_WORKFLOW_FILES } from './cloud-workflow-files';
import { createProvider, providerFetch, signToken, type TestProvider } from './support';

// The shipped Kilo-Org/cloud CI bundle policies, checked against the exact GitHub Actions identities
// their workflows present. Kilo-Org/cloud issues the immutable subject format.
const STS_ISSUER = 'https://sts.test';
const GITHUB_ISSUER = 'https://token.actions.githubusercontent.com';
const REPOSITORY_ID = '1145038391';
const OWNER_ID = '201822503';
const WORKFLOWS = 'Kilo-Org/cloud/.github/workflows';
const MAIN = 'refs/heads/main';
const CARVE_OUT_EVENTS = ['workflow_run', 'schedule', 'workflow_dispatch'];

type StsEnvironment = 'production' | 'staging' | 'development';

type Expected = {
  workload: string;
  stsEnvironment: StsEnvironment;
  /** The GitHub environment; absent for a job without one. */
  environment?: string;
  workflow: string;
  events: string[];
  secrets: string[];
  /** Inside D53_M112_CI_BUNDLE_CARVE_OUT. */
  carveOut: boolean;
};

const EXPECTED: Expected[] = [
  {
    workload: 'ci-vercel-stage',
    stsEnvironment: 'production',
    environment: 'production',
    workflow: 'stage-vercel-deployment.yml',
    events: CARVE_OUT_EVENTS,
    secrets: [
      'VERCEL_TOKEN_APP',
      'VERCEL_TOKEN_AI_GATEWAY',
      'VERCEL_TOKEN_AI_GATEWAY_SECURE_PROXY',
    ],
    carveOut: true,
  },
  {
    workload: 'ci-vercel-stage-staging',
    stsEnvironment: 'production',
    environment: 'staging',
    workflow: 'stage-vercel-deployment.yml',
    events: CARVE_OUT_EVENTS,
    secrets: ['VERCEL_TOKEN_APP', 'VERCEL_TOKEN_AI_GATEWAY'],
    carveOut: true,
  },
  {
    workload: 'ci-vercel-promote',
    stsEnvironment: 'production',
    environment: 'production',
    workflow: 'promote-vercel-deployment.yml',
    events: CARVE_OUT_EVENTS,
    secrets: ['VERCEL_TOKEN', 'AXIOM_ANNOTATION_TOKEN'],
    carveOut: true,
  },
  {
    workload: 'ci-cloud-agent-sentry',
    stsEnvironment: 'production',
    environment: 'production',
    workflow: 'cloud-agent-sentry-sourcemaps.yml',
    events: CARVE_OUT_EVENTS,
    secrets: ['SENTRY_AUTH_TOKEN'],
    carveOut: true,
  },
  {
    workload: 'ci-cloud-agent-sentry-staging',
    stsEnvironment: 'production',
    environment: 'staging',
    workflow: 'cloud-agent-sentry-sourcemaps.yml',
    events: CARVE_OUT_EVENTS,
    secrets: ['SENTRY_AUTH_TOKEN'],
    carveOut: true,
  },
  {
    workload: 'ci-kilo-app-release',
    stsEnvironment: 'production',
    environment: 'release',
    workflow: 'kilo-app-release.yml',
    events: ['push', 'schedule', 'workflow_dispatch'],
    secrets: ['EXPO_TOKEN'],
    carveOut: false,
  },
  {
    workload: 'ci-auto-docs',
    stsEnvironment: 'production',
    environment: 'production',
    workflow: 'auto-docs.yml',
    events: ['push', 'workflow_dispatch'],
    secrets: ['DOC_WEBHOOK_URL', 'DOC_WEBHOOK_SECRET'],
    carveOut: false,
  },
  {
    workload: 'ci-kiloclaw-dev-push',
    stsEnvironment: 'staging',
    workflow: 'push-dev-kiloclaw.yml',
    events: ['workflow_dispatch'],
    secrets: ['FLY_DEV_API_TOKEN'],
    carveOut: false,
  },
];

/** Every GitHub environment a cloud job can name, plus none. */
const GITHUB_ENVIRONMENTS = [
  'production',
  'staging',
  'release',
  'kilo-mcp-release',
  'cloud-agent-e2e',
  'cloud-agent-runtime-publication',
  'copilot',
  'scheduled-deploy-production',
  undefined,
];

const pinned = (file: string, ref = MAIN) => `${WORKFLOWS}/${file}@${ref}`;

function claims(
  environment: string | undefined,
  file: string,
  event: string,
  ref = MAIN
): Record<string, string> {
  const repository = `repo:Kilo-Org@${OWNER_ID}/cloud@${REPOSITORY_ID}`;
  return {
    sub:
      environment === undefined
        ? `${repository}:ref:${ref}`
        : `${repository}:environment:${environment}`,
    repository_id: REPOSITORY_ID,
    repository_owner_id: OWNER_ID,
    repository: 'Kilo-Org/cloud',
    repository_owner: 'Kilo-Org',
    ...(environment === undefined ? {} : { environment }),
    ref,
    event_name: event,
    job_workflow_ref: pinned(file, ref),
    workflow_ref: pinned(file, ref),
    run_id: '4242',
  };
}

async function fixture(environment: StsEnvironment): Promise<{
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
  policy.events.map(event => [policy.workload, policy.workflow, event, policy] as const)
);

/** The cloud policies whose bundle holds a secret, by workload. */
function secretHolders(): Set<string> {
  return new Set(
    policyIndex
      .all()
      .filter(policy => policy.identity.kind === 'github-oidc' && policy.secrets.length > 0)
      .filter(
        policy =>
          policy.identity.kind === 'github-oidc' && policy.identity.repositoryId === REPOSITORY_ID
      )
      .map(policy => policy.workload)
  );
}

describe('shipped Kilo-Org/cloud CI bundle policies', () => {
  it('load with exactly the requested identity and secrets, bundles in /ci', () => {
    const shipped = policyIndex
      .all()
      .filter(policy => policy.identity.kind === 'github-oidc')
      .filter(
        policy =>
          policy.identity.kind === 'github-oidc' &&
          policy.identity.repositoryId === REPOSITORY_ID &&
          policy.secrets.length > 0
      );
    expect(shipped.map(policy => policy.workload).sort()).toEqual(
      EXPECTED.map(policy => policy.workload).sort()
    );
    for (const expected of EXPECTED) {
      const policy = policyIndex.get(expected.stsEnvironment, expected.workload);
      expect(policy, expected.workload).toMatchObject({
        workload: expected.workload,
        environments: [expected.stsEnvironment],
        secrets: expected.secrets,
        audiences: [],
        scopes: [],
        dynamic: [],
        identity: {
          kind: 'github-oidc',
          repository: 'Kilo-Org/cloud',
          repositoryId: REPOSITORY_ID,
          repositoryOwnerId: OWNER_ID,
          refs: [MAIN],
          jobWorkflowRefs: [pinned(expected.workflow)],
          events: expected.events,
        },
      });
      expect(policy?.identity).not.toHaveProperty('legacySubject');
      if (policy === null || policy.identity.kind !== 'github-oidc') {
        throw new Error(`${expected.workload} is not served in ${expected.stsEnvironment}`);
      }
      expect(policy.identity.environment).toBe(expected.environment);
      for (const other of ['production', 'staging', 'development'] as const) {
        if (other !== expected.stsEnvironment) {
          expect(policyIndex.get(other, expected.workload)).toBeNull();
        }
      }
      expect(bundleFolder(policy)).toEqual({ root: '/ci', path: `/ci/${expected.workload}` });
    }
  });

  it.each(cases)('issues %s for %s on %s', async (workload, file, event, policy) => {
    const { verify } = await fixture(policy.stsEnvironment);
    expect(await verify(claims(policy.environment, file, event))).toMatchObject({
      status: 'verified',
      workload,
      provider: 'github',
      run: { jobWorkflowRef: pinned(file), runId: '4242' },
    });
  });

  it.each(cases)('refuses %s for %s on another ref', async (workload, file, event, policy) => {
    const { verify } = await fixture(policy.stsEnvironment);
    for (const ref of [
      'refs/heads/feature',
      'refs/heads/main2',
      'refs/tags/v1',
      'refs/pull/1/merge',
    ]) {
      for (const jobWorkflowRef of [pinned(file, ref), pinned(file)]) {
        const outcome = await verify({
          ...claims(policy.environment, file, event),
          ref,
          job_workflow_ref: jobWorkflowRef,
        });
        expect(outcome, `${ref} ${jobWorkflowRef}`).toMatchObject({ status: 'denied' });
        expect(outcome).not.toMatchObject({ workload });
      }
    }
  });

  it.each(EXPECTED)('refuses $workload on an unlisted event', async policy => {
    const { verify } = await fixture(policy.stsEnvironment);
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
      expect(await verify(claims(policy.environment, policy.workflow, event)), event).toMatchObject(
        {
          status: 'denied',
          reason: 'identity_rejected',
          subject: { actor: policy.workload, claims: { event_name: event } },
        }
      );
    }
  });

  it.each(EXPECTED)('refuses $workload in another GitHub environment', async policy => {
    const { verify } = await fixture(policy.stsEnvironment);
    for (const environment of GITHUB_ENVIRONMENTS) {
      if (environment === policy.environment) continue;
      const outcome = await verify(claims(environment, policy.workflow, policy.events[0] ?? ''));
      // The same file in its other environment may verify, as that environment's own policy.
      expect(outcome, `${policy.workload} in ${environment ?? 'no environment'}`).not.toMatchObject(
        { workload: policy.workload }
      );
      if (outcome.status === 'verified') {
        expect(
          EXPECTED.some(
            other =>
              other.workload === outcome.workload &&
              other.workflow === policy.workflow &&
              other.environment === environment
          ),
          `${policy.workload} in ${environment ?? 'no environment'}`
        ).toBe(true);
      }
    }
  });

  it('refuses another repository id or owner id', async () => {
    const { verify } = await fixture('production');
    const base = claims('production', 'promote-vercel-deployment.yml', 'workflow_run');
    const changes: Record<string, string>[] = [
      { repository_id: '999999999' },
      { repository_owner_id: '1' },
      { sub: `repo:Kilo-Org@${OWNER_ID}/cloud@999999999:environment:production` },
      { sub: 'repo:Kilo-Org/cloud:environment:production' },
    ];
    for (const ids of changes) {
      const outcome = await verify({ ...base, ...ids });
      expect(outcome, JSON.stringify(ids)).toMatchObject({ status: 'denied' });
      expect(outcome).not.toMatchObject({ workload: 'ci-vercel-promote' });
    }
  });

  // D53/M112 security requirement: each carve-out policy admits one workflow file, and a token from
  // any other workflow file of this repository, on the carve-out triggers and in that policy's
  // GitHub environment, opens no secret bundle of it.
  describe('D53/M112 carve-out', () => {
    const carved = EXPECTED.filter(policy => policy.carveOut);

    it('lists exactly the carved-out policies, each with one workflow file of the carve-out', () => {
      const files: readonly string[] = D53_M112_CI_BUNDLE_CARVE_OUT.jobWorkflowRefs;
      const inCarveOut = policyIndex
        .all()
        .filter(
          policy =>
            policy.identity.kind === 'github-oidc' &&
            policy.identity.jobWorkflowRefs.some(entry => files.includes(entry))
        );
      expect(inCarveOut.map(policy => policy.workload).sort()).toEqual(
        carved.map(policy => policy.workload).sort()
      );
      for (const policy of inCarveOut) {
        if (policy.identity.kind !== 'github-oidc') throw new Error(policy.workload);
        expect(policy.identity.jobWorkflowRefs, policy.workload).toHaveLength(1);
      }
      // Every carve-out file is used by a shipped policy.
      expect(
        files.every(file =>
          inCarveOut.some(
            policy =>
              policy.identity.kind === 'github-oidc' && policy.identity.jobWorkflowRefs[0] === file
          )
        )
      ).toBe(true);
    });

    it.each(carved)(
      'refuses every other workflow file for $workload on the carve-out triggers',
      async policy => {
        const { verify } = await fixture(policy.stsEnvironment);
        const holders = secretHolders();
        for (const file of CLOUD_WORKFLOW_FILES) {
          if (file === policy.workflow) continue;
          for (const event of CARVE_OUT_EVENTS) {
            const outcome = await verify(claims(policy.environment, file, event));
            expect(outcome, `${file} ${event}`).not.toMatchObject({ workload: policy.workload });
            // A token of another file may match only that file's own policy, which then is not a
            // secret bundle of another workflow: ci-db-migrate owns deploy-production.yml.
            if (outcome.status === 'verified') {
              expect(holders.has(outcome.workload), `${file} ${event}`).toBe(
                EXPECTED.some(
                  other => other.workload === outcome.workload && other.workflow === file
                )
              );
            }
          }
        }
      }
    );

    it.each(carved)('matches the job workflow ref of $workload exactly', async policy => {
      const { verify } = await fixture(policy.stsEnvironment);
      const job = pinned(policy.workflow);
      const stem = policy.workflow.replace(/\.yml$/, '');
      for (const jobWorkflowRef of [
        `${WORKFLOWS}/${policy.workflow}`,
        `${WORKFLOWS}/${policy.workflow}@refs/heads/mai`,
        `${WORKFLOWS}/${policy.workflow}@refs/heads/main/x`,
        `${WORKFLOWS}/${stem}.yaml@${MAIN}`,
        `${WORKFLOWS}/x-${policy.workflow}@${MAIN}`,
        `${WORKFLOWS}/sub/${policy.workflow}@${MAIN}`,
        `${WORKFLOWS}/*.yml@${MAIN}`,
        `kilo-org/cloud/.github/workflows/${policy.workflow}@${MAIN}`,
        `Kilo-Org/cloud-fork/.github/workflows/${policy.workflow}@${MAIN}`,
        `x${job}`,
        `${job}x`,
      ]) {
        for (const event of policy.events) {
          const outcome = await verify({
            ...claims(policy.environment, policy.workflow, event),
            job_workflow_ref: jobWorkflowRef,
          });
          expect(outcome, `${jobWorkflowRef} ${event}`).toMatchObject({ status: 'denied' });
        }
      }
    });

    const carveOutPolicy = (overrides: {
      workload?: string;
      environments?: string;
      repositoryId?: string;
      environment?: string | null;
      refs?: string;
      workflows?: string;
      events?: string;
      extra?: string;
      secrets?: string;
    }) => `
workload: ${overrides.workload ?? 'ci-carve-test'}
environments: ${overrides.environments ?? '[production]'}
identity:
  kind: github-oidc
  repository: Kilo-Org/cloud
  repositoryId: '${overrides.repositoryId ?? REPOSITORY_ID}'
  repositoryOwnerId: '${OWNER_ID}'
${overrides.environment === null ? '' : `  environment: ${overrides.environment ?? 'production'}\n`}  refs: ${overrides.refs ?? `[${MAIN}]`}
  jobWorkflowRefs: ${overrides.workflows ?? `[${pinned('promote-vercel-deployment.yml')}]`}
  events: ${overrides.events ?? '[workflow_run, schedule, workflow_dispatch]'}
secrets: ${overrides.secrets ?? '[VERCEL_TOKEN]'}
${overrides.extra ?? ''}`;

    const load = (source: string) => () => loadPolicies({ 'ci-carve-test.yaml': source });

    it('admits a policy that meets every condition', () => {
      expect(load(carveOutPolicy({}))).not.toThrow();
      expect(load(carveOutPolicy({ events: '[workflow_run]' }))).not.toThrow();
    });

    it.each([
      [
        'a second workflow file',
        {
          workflows: `[${pinned('promote-vercel-deployment.yml')}, ${pinned('stage-vercel-deployment.yml')}]`,
        },
      ],
      ['a file outside the carve-out', { workflows: `[${pinned('deploy-workers.yml')}]` }],
      ['the push event', { events: '[workflow_run, push]' }],
      ['another repository id', { repositoryId: '1395255492' }],
      ['no GitHub environment', { environment: null }],
      ['no secret', { secrets: '[]' }],
      ['a token grant', { extra: "audiences: [web]\nscopes: ['web:sts.canary']" }],
    ])('refuses workflow_run with other events in production with %s', (_name, overrides) => {
      expect(load(carveOutPolicy(overrides))).toThrow(/workflow_run/);
    });

    it('refuses a carve-out file on another ref', () => {
      expect(
        load(
          carveOutPolicy({
            refs: '[refs/heads/main, refs/heads/release]',
            workflows: `[${pinned('promote-vercel-deployment.yml', 'refs/heads/release')}]`,
          })
        )
      ).toThrow(/workflow_run|accepts only refs\/heads\/main/);
    });
  });
});
