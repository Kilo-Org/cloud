import { describe, expect, it } from 'vitest';
import { policyIndex } from '../../src/policy';
import { loadPolicies } from '../../src/policy/load';
import { Q71_CLOUDFLARE_DEPLOY_CARVE_OUT } from '../../src/policy/schema';

const DEPLOY_WORKERS = 'Kilo-Org/cloud/.github/workflows/deploy-workers.yml@refs/heads/main';
const RUNTIME_PUBLISH =
  'Kilo-Org/cloud/.github/workflows/cloud-agent-runtime-publish.yml@refs/heads/main';
const SCRIPTS = 'e086da7e2179491d91ee5f35b3ca210a';

/** A Kilo-Org/cloud deploy policy; each part can be replaced to break one rule. */
function deployPolicy(
  parts: {
    environments?: string;
    repositoryId?: string;
    environment?: string;
    workflow?: string;
    events?: string;
    rest?: string;
  } = {}
): string {
  return `workload: ci-deploy-x
environments: ${parts.environments ?? '[production]'}
identity:
  kind: github-oidc
  repository: Kilo-Org/cloud
  repositoryId: '${parts.repositoryId ?? '1145038391'}'
  repositoryOwnerId: '201822503'
${parts.environment ?? '  environment: production\n'}  refs: [refs/heads/main]
  jobWorkflowRefs: [${parts.workflow ?? DEPLOY_WORKERS}]
  events: ${parts.events ?? '[workflow_run, schedule, workflow_dispatch]'}
${
  parts.rest ??
  `secrets: []
dynamic:
  - grant: cloudflare-deploy
    permissionSet: x
    permissionGroups:
      - { id: ${SCRIPTS}, name: Workers Scripts Write, scope: account }
    intendedScripts: [x]
    maxActive: 2
    maxPerHour: 12
    maxPerRun: 40
`
}`;
}

function load(source: string) {
  return loadPolicies({ 'ci-deploy-x.yaml': source });
}

describe('Kilo-Org/cloud deploy policies', () => {
  it('ship for deploy-workers.yml in production and staging, the runtime publisher and the catalog index', () => {
    for (const [environment, workload, githubEnvironment, workflow, events] of [
      [
        'production',
        'ci-deploy-cloud',
        'production',
        DEPLOY_WORKERS,
        ['workflow_run', 'schedule', 'workflow_dispatch'],
      ],
      [
        'staging',
        'ci-deploy-cloud-staging',
        'staging',
        DEPLOY_WORKERS,
        ['workflow_run', 'schedule', 'workflow_dispatch'],
      ],
      [
        'production',
        'ci-deploy-cloud-runtime',
        'cloud-agent-runtime-publication',
        RUNTIME_PUBLISH,
        ['workflow_run', 'workflow_dispatch'],
      ],
      [
        'production',
        'ci-deploy-cloud-mcp-catalog',
        'production',
        'Kilo-Org/cloud/.github/workflows/kilo-mcp-catalog.yml@refs/heads/main',
        ['push'],
      ],
    ] as const) {
      const policy = policyIndex.get(environment, workload);
      expect(policy, workload).toMatchObject({
        environments: [environment],
        secrets: [],
        audiences: [],
        scopes: [],
        identity: {
          kind: 'github-oidc',
          repository: 'Kilo-Org/cloud',
          repositoryId: '1145038391',
          repositoryOwnerId: '201822503',
          environment: githubEnvironment,
          refs: ['refs/heads/main'],
          jobWorkflowRefs: [workflow],
          events,
        },
      });
      expect(policy?.dynamic.map(entry => entry.grant)).toEqual(['cloudflare-deploy']);
      // Default deny: no other STS environment serves it.
      for (const other of ['development', 'staging', 'production'] as const) {
        if (other !== environment) expect(policyIndex.get(other, workload)).toBeNull();
      }
    }
  });

  it('keep every grant within the design limits, and count the Worker deploys per run', () => {
    const production = policyIndex.get('production', 'ci-deploy-cloud')?.dynamic[0];
    expect(production).toMatchObject({
      maxActive: 2,
      maxPerHour: 12,
      maxPerRun: 40,
      ttlSeconds: 3600,
    });
    const staging = policyIndex.get('staging', 'ci-deploy-cloud-staging')?.dynamic[0];
    expect(staging).toMatchObject({
      maxActive: 2,
      maxPerHour: 12,
      maxPerRun: 16,
      ttlSeconds: 3600,
    });
    // The staging token holds no container, route or D1 right.
    expect(
      staging?.grant === 'cloudflare-deploy' && staging.permissionGroups.map(group => group.name)
    ).toEqual(['Workers Scripts Write', 'Queues Write']);
  });

  it('accept workflow_run with the other events and production for the carved-out deploy files (PENDING IGOR)', () => {
    expect(load(deployPolicy()).has('ci-deploy-x')).toBe(true);
    expect(
      load(
        deployPolicy({ workflow: RUNTIME_PUBLISH, events: '[workflow_run, workflow_dispatch]' })
      ).has('ci-deploy-x')
    ).toBe(true);
    expect(Q71_CLOUDFLARE_DEPLOY_CARVE_OUT.jobWorkflowRefs).toEqual([
      DEPLOY_WORKERS,
      RUNTIME_PUBLISH,
    ]);
  });

  it.each([
    [
      'another workflow file',
      { workflow: 'Kilo-Org/cloud/.github/workflows/ci.yml@refs/heads/main' },
      'accepts no other event',
    ],
    ['another repository id', { repositoryId: '1145038392' }, 'accepts no other event'],
    ['push among the events', { events: '[workflow_run, push]' }, 'accepts no other event'],
    [
      'a secret beside the deploy grant',
      {
        rest: `secrets: [SOME_SECRET]
dynamic:
  - grant: cloudflare-deploy
    permissionSet: x
    permissionGroups:
      - { id: ${SCRIPTS}, name: Workers Scripts Write, scope: account }
    intendedScripts: [x]
    maxActive: 1
    maxPerHour: 12
`,
      },
      'accepts no other event',
    ],
    ['no deploy grant', { rest: 'secrets: []\n' }, 'accepts no other event'],
  ])('keep the Q71 rule for %s', (_name, parts, message) => {
    expect(() => load(deployPolicy(parts))).toThrow(message);
    expect(() => load(deployPolicy(parts))).toThrow('cannot grant production');
  });

  it('keep the environment binding a workflow_run policy needs', () => {
    expect(() => load(deployPolicy({ environments: '[staging]', environment: '' }))).toThrow(
      'a github-oidc policy that accepts workflow_run must bind identity.environment'
    );
  });

  it('share no identity: one policy per GitHub environment and workflow file', () => {
    expect(() =>
      loadPolicies({
        'ci-deploy-x.yaml': deployPolicy(),
        'ci-deploy-y.yaml': deployPolicy().replace(
          'workload: ci-deploy-x',
          'workload: ci-deploy-y'
        ),
      })
    ).toThrow('declare the same identity');
  });
});
