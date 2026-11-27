import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { policyChangedEvent } from '../../src/audit/events';
import { resolveWorkloadSecrets } from '../../src/bundle/resolve';
import { loadPolicies } from '../../src/policy/load';
import { policyFor, policyIndex } from '../../src/policy';
import { PolicySnapshotSchema, bundleFolder } from '../../src/policy/schema';

const REGISTRY = {
  gateway: { scopes: ['gateway:models.read', 'gateway:usage.write'] },
  o11y: { scopes: ['o11y:alerts.read'] },
};

/** The shipped web policy's grants in every environment. */
const WEB_BASE_SCOPES = [
  'usage-ingest:sts.canary',
  'usage-ingest:usage.publish',
  'o11y:api-metrics.write',
  'o11y:alerting.read',
  'o11y:alerting.write',
];

/** The shipped ai-gateway policy's grants in every environment. */
const GATEWAY_BASE_SCOPES = [
  'usage-ingest:usage.publish',
  'o11y:api-metrics.write',
  'ai-gateway-secure-proxy:request.forward',
];

function withGrants(grants: string): string {
  return `${valid}${grants}`;
}

function expectGrantThrow(grants: string, fragment: string): void {
  expect(() =>
    loadPolicies({ 'app-one.yaml': withGrants(grants) }, { scopeRegistry: REGISTRY })
  ).toThrow(fragment);
}

describe('policy token grants', () => {
  it('defaults to no audience, no scope and no dynamic grant', () => {
    const policy = loadPolicies({ 'app-one.yaml': valid }).get('production', 'app-one');
    expect(policy).toMatchObject({ audiences: [], scopes: [], dynamic: [] });
  });

  it('accepts registered scopes under listed audiences', () => {
    const index = loadPolicies(
      {
        'app-one.yaml': withGrants(
          `audiences: [gateway, o11y]\nscopes: ['gateway:models.read', 'o11y:alerts.read']\n`
        ),
      },
      { scopeRegistry: REGISTRY }
    );
    expect(index.get('production', 'app-one')).toMatchObject({
      audiences: ['gateway', 'o11y'],
      scopes: ['gateway:models.read', 'o11y:alerts.read'],
    });
  });

  it('refuses a scope outside the registry, under an unlisted audience, or an audience without a scope', () => {
    expectGrantThrow(
      `audiences: [gateway]\nscopes: ['gateway:admin']\n`,
      'scope gateway:admin is not in STS_SCOPE_REGISTRY'
    );
    expectGrantThrow(
      `audiences: [o11y]\nscopes: ['o11y:alerts.read', 'gateway:models.read']\n`,
      'which audiences does not list'
    );
    expectGrantThrow(
      `audiences: [gateway, o11y]\nscopes: ['gateway:models.read']\n`,
      'audience o11y has no scope'
    );
  });

  it('refuses any policy that grants the reserved denied probe or its audience, whatever the registry says', () => {
    const probe = `audiences: [canary]\nscopes: ['canary:denied-probe']\n`;
    // The shipped registry lists the probe, so only its reservation refuses it.
    expect(() => loadPolicies({ 'app-one.yaml': withGrants(probe) })).toThrow(
      'scope canary:denied-probe is reserved and no policy may grant it'
    );
    expect(() =>
      loadPolicies(
        { 'app-one.yaml': withGrants(probe) },
        { scopeRegistry: { ...REGISTRY, canary: { scopes: ['canary:denied-probe'] } } }
      )
    ).toThrow('scope canary:denied-probe is reserved and no policy may grant it');
    expect(() =>
      loadPolicies(
        {
          'app-one.yaml': withGrants(
            `audiences: [canary, web]\nscopes: ['canary:other', 'web:sts.canary']\n`
          ),
        },
        {
          scopeRegistry: {
            canary: { scopes: ['canary:denied-probe', 'canary:other'] },
            web: { scopes: ['web:sts.canary'] },
          },
        }
      )
    ).toThrow('audience canary is reserved and no policy may grant it');
    // The shipped web policy, which sends the probe, grants neither.
    expect(policyIndex.get('production', 'web')).toMatchObject({
      audiences: ['usage-ingest', 'o11y'],
      scopes: WEB_BASE_SCOPES,
    });
  });

  it('refuses an audience equal to the workload, duplicates, and a dynamic grant that is no lease', () => {
    expect(() =>
      loadPolicies(
        {
          'o11y.yaml': `
workload: o11y
environments: [production]
identity:
  kind: worker-binding
secrets: []
audiences: [o11y]
scopes: ['o11y:alerts.read']
`,
        },
        { scopeRegistry: REGISTRY }
      )
    ).toThrow('audience o11y is the workload itself');
    expectGrantThrow(
      `audiences: [gateway, gateway]\nscopes: ['gateway:models.read']\n`,
      'audiences contains a duplicate'
    );
    expectGrantThrow(`dynamic: [ci_migration_role]\n`, 'does not match the policy schema');
    expectGrantThrow(
      `dynamic:\n  - grant: cloudflare-deploy-token\n    maxTtlSeconds: 3600\n    defaultTtlSeconds: 3600\n    maxActive: 1\n`,
      'does not match the policy schema'
    );
  });

  it('checks shipped policies against the shipped registry, which lists only the pilot scopes', () => {
    expect(() =>
      loadPolicies({
        'app-one.yaml': withGrants(`audiences: [gateway]\nscopes: ['gateway:models.read']\n`),
      })
    ).toThrow('is not in STS_SCOPE_REGISTRY');
  });

  it('lists added and removed audience and scope grants in the policy.changed event', () => {
    const before = loadPolicies(
      {
        'app-one.yaml': withGrants(`audiences: [gateway]\nscopes: ['gateway:models.read']\n`),
      },
      { scopeRegistry: REGISTRY }
    );
    const after = loadPolicies(
      {
        'app-one.yaml': withGrants(
          `audiences: [o11y, gateway]\nscopes: ['gateway:usage.write', 'o11y:alerts.read']\n`
        ),
      },
      { scopeRegistry: REGISTRY }
    );
    const event = policyChangedEvent({
      environment: 'production',
      policyHash: 'after',
      previousPolicyHash: 'before',
      previous: before.snapshot('production'),
      current: after.snapshot('production'),
    });
    expect(event.data.attributes).toMatchObject({
      addedAudiences: ['app-one:o11y'],
      removedAudiences: [],
      addedScopes: ['app-one:gateway:usage.write', 'app-one:o11y:alerts.read'],
      removedScopes: ['app-one:gateway:models.read'],
      audiencesTruncated: false,
      scopesTruncated: false,
      addedSecrets: [],
      removedSecrets: [],
    });
  });

  it('stores a policy without token grants in the snapshot format of the version before grants', () => {
    // The strict parser of the version before token grants: a rollback to it must read the snapshot.
    const BaseSnapshotEntrySchema = z.strictObject({
      workload: z.string(),
      environments: z.array(z.string()),
      identity: z.string(),
      secrets: z.array(z.string()),
    });
    const [entry] = loadPolicies({ 'app-one.yaml': valid }).snapshot('production');
    expect(BaseSnapshotEntrySchema.safeParse(entry).success).toBe(true);
  });
});

const valid = `
workload: app-one
environments: [production]
identity:
  kind: worker-binding
secrets: [APP_ONE_SECRET]
`;

function expectThrow(sources: Record<string, string>, fragment: string): void {
  expect(() => loadPolicies(sources)).toThrow(fragment);
}

describe('policy schema', () => {
  it('rejects an unknown field at any level', () => {
    expectThrow({ 'app-one.yaml': `${valid}owner: someone\n` }, 'does not match the policy schema');
    expectThrow(
      {
        'app-one.yaml': `
workload: app-one
environments: [production]
identity:
  kind: fly-oidc
  org: acme
  orgId: '10'
  app: app-one
  appId: '20'
  machine: m1
secrets: [APP_ONE_SECRET]
`,
      },
      'does not match the policy schema'
    );
  });

  it('rejects a file whose name is not its workload', () => {
    expectThrow({ 'other.yaml': valid }, 'must be named app-one.yaml');
  });

  it('rejects an empty environment list and a duplicate entry', () => {
    expectThrow(
      { 'app-one.yaml': valid.replace('environments: [production]', 'environments: []') },
      'does not match the policy schema'
    );
    expectThrow(
      {
        'app-one.yaml': valid.replace(
          'environments: [production]',
          'environments: [production, production]'
        ),
      },
      'environments contains a duplicate'
    );
  });

  it('rejects a secret name that is not canonical', () => {
    expectThrow(
      { 'app-one.yaml': valid.replace('APP_ONE_SECRET', 'APP_ONE_SECRET_PROD') },
      'carries an environment suffix'
    );
  });

  describe('github-oidc', () => {
    const RELEASE = 'acme/repo/.github/workflows/publish.yml@refs/heads/main';
    const github = (options: {
      workload?: string;
      environments?: string;
      environment?: string | null;
      repository?: string;
      identity?: string;
      workflows?: string;
      events?: string;
      extra?: string;
    }) => `
workload: ${options.workload ?? 'ci-release'}
environments: ${options.environments ?? '[production]'}
identity:
  kind: github-oidc
  repository: ${options.repository ?? 'acme/repo'}
  repositoryId: '123'
  repositoryOwnerId: '456'${options.environment === null ? '' : `\n  environment: ${options.environment ?? 'release'}`}
  jobWorkflowRefs: ${options.workflows ?? `[${RELEASE}]`}
  events: ${options.events ?? '[workflow_dispatch]'}${options.identity ?? ''}
secrets: [APP_ONE_SECRET]
${options.extra ?? ''}`;

    it('loads several policies on one repository and defaults refs to refs/heads/main', () => {
      const index = loadPolicies({
        'ci-release.yaml': github({}),
        'ci-automation.yaml': github({
          workload: 'ci-automation',
          environment: 'automation',
          workflows: `[${RELEASE}, acme/repo/.github/workflows/beta.yml@refs/heads/main]`,
          events: '[push, schedule]',
        }),
      });
      expect(index.get('production', 'ci-release')?.identity).toMatchObject({
        kind: 'github-oidc',
        environment: 'release',
        refs: ['refs/heads/main'],
      });
      expect(index.snapshot('production').map(entry => entry.identity)).toEqual([
        `github-oidc|acme/repo|123|456|automation|refs/heads/main|acme/repo/.github/workflows/beta.yml@refs/heads/main,${RELEASE}|push,schedule`,
        `github-oidc|acme/repo|123|456|release|refs/heads/main|${RELEASE}|workflow_dispatch`,
      ]);
    });

    it('refuses two policies that accept the same environment and workflow file', () => {
      expectThrow(
        {
          'ci-release.yaml': github({}),
          'ci-release-two.yaml': github({
            workload: 'ci-release-two',
            workflows: `[acme/repo/.github/workflows/other.yml@refs/heads/main, ${RELEASE}]`,
          }),
        },
        'workloads ci-release and ci-release-two declare the same identity'
      );
    });

    it('requires identity.environment for production and for token grants', () => {
      expectThrow(
        { 'ci-release.yaml': github({ environment: null }) },
        'a github-oidc policy that grants production must bind identity.environment'
      );
      expect(() =>
        loadPolicies(
          {
            'ci-release.yaml': github({
              environment: null,
              environments: '[staging]',
              extra: `audiences: [gateway]\nscopes: ['gateway:models.read']\n`,
            }),
          },
          { scopeRegistry: REGISTRY }
        )
      ).toThrow('a github-oidc policy that grants tokens must bind identity.environment');
    });

    it('accepts only refs/heads/main for production', () => {
      expectThrow(
        {
          'ci-release.yaml': github({
            identity: '\n  refs: [refs/heads/main, refs/heads/release]',
          }),
        },
        'a github-oidc policy that grants production accepts only refs/heads/main'
      );
    });

    it('allows identity.legacySubject only for Kilo-Org/kilocode with its ids', () => {
      const kilocode = (repository: string, repositoryId: string, ownerId: string) =>
        github({
          repository,
          workflows: `[${repository}/.github/workflows/publish.yml@refs/heads/main]`,
          identity: '\n  legacySubject: true',
        })
          .replace("repositoryId: '123'", `repositoryId: '${repositoryId}'`)
          .replace("repositoryOwnerId: '456'", `repositoryOwnerId: '${ownerId}'`);
      const loaded = loadPolicies({
        'ci-release.yaml': kilocode('Kilo-Org/kilocode', '946087422', '201822503'),
      });
      expect(loaded.get('production', 'ci-release')?.identity).toMatchObject({
        legacySubject: true,
      });
      expect(loaded.snapshot('production')[0]?.identity).toMatch(/\|legacy-subject$/);
      for (const [repository, repositoryId, ownerId] of [
        ['acme/repo', '123', '456'],
        ['Kilo-Org/kilocode', '1395255492', '201822503'],
        ['Kilo-Org/kilocode', '946087422', '1'],
        ['Kilo-Org/bouncer', '946087422', '201822503'],
      ] as const) {
        expectThrow(
          { 'ci-release.yaml': kilocode(repository, repositoryId, ownerId) },
          'identity.legacySubject is allowed only for Kilo-Org/kilocode'
        );
      }
    });

    it('rejects a workflow of another repository, a wildcard, and a ref refs does not list', () => {
      expectThrow(
        {
          'ci-release.yaml': github({
            workflows: '[acme/other/.github/workflows/publish.yml@refs/heads/main]',
          }),
        },
        'is not a workflow file of acme/repo'
      );
      expectThrow(
        {
          'ci-release.yaml': github({
            workflows: "['acme/repo/.github/workflows/*.yml@refs/heads/main']",
          }),
        },
        'does not match the policy schema'
      );
      expectThrow(
        { 'ci-release.yaml': github({ workflows: '[acme/repo/.github/workflows/publish.yml]' }) },
        'does not match the policy schema'
      );
      expectThrow(
        {
          'ci-release.yaml': github({
            environments: '[staging]',
            identity: '\n  refs: [refs/heads/develop]',
          }),
        },
        'runs on a ref that identity.refs does not list'
      );
    });

    it('bounds a workflow ref at 512 characters, the most a delivery-row attribute holds', () => {
      const repository = `${'o'.repeat(39)}/${'r'.repeat(100)}`;
      const branch = (length: number) => `refs/heads/${'b'.repeat(length)}`;
      const policy = (length: number) =>
        github({
          environments: '[staging]',
          repository,
          workflows: `[${repository}/.github/workflows/${'w'.repeat(200)}.yml@${branch(length)}]`,
          identity: `\n  refs: [${branch(length)}]`,
        });
      expect(() => loadPolicies({ 'ci-release.yaml': policy(137) })).not.toThrow();
      expectThrow({ 'ci-release.yaml': policy(138) }, 'does not match the policy schema');
    });

    it.each(['pull_request', 'pull_request_target', 'issues', 'issue_comment', 'merge_group'])(
      'cannot list the %s event',
      event => {
        expectThrow(
          { 'ci-release.yaml': github({ events: `[${event}]` }) },
          'does not match the policy schema'
        );
      }
    );

    it('accepts workflow_run only as the one event of a policy', () => {
      expect(() =>
        loadPolicies({
          'ci-release.yaml': github({ environments: '[staging]', events: '[workflow_run]' }),
        })
      ).not.toThrow();
      expectThrow(
        {
          'ci-release.yaml': github({ environments: '[staging]', events: '[workflow_run, push]' }),
        },
        'a github-oidc policy that accepts workflow_run accepts no other event'
      );
    });

    it('refuses workflow_run for production, whose upstream run STS cannot see', () => {
      expectThrow(
        { 'ci-release.yaml': github({ events: '[workflow_run]' }) },
        'a github-oidc policy that accepts workflow_run cannot grant production'
      );
      expectThrow(
        {
          'ci-release.yaml': github({
            environments: '[staging, production]',
            events: '[workflow_run]',
          }),
        },
        'a github-oidc policy that accepts workflow_run cannot grant production'
      );
    });

    it('requires identity.environment for a workflow_run policy', () => {
      expectThrow(
        {
          'ci-release.yaml': github({
            environments: '[staging]',
            environment: null,
            events: '[workflow_run]',
          }),
        },
        'a github-oidc policy that accepts workflow_run must bind identity.environment'
      );
    });

    it('rejects the removed allowedEvents and environments fields', () => {
      expectThrow(
        { 'ci-release.yaml': github({ identity: '\n  allowedEvents: [workflow_run]' }) },
        'does not match the policy schema'
      );
      expectThrow(
        { 'ci-release.yaml': github({ identity: '\n  environments: [release]' }) },
        'does not match the policy schema'
      );
    });

    it('names a GitHub workload ci-<job> and resolves its bundle from /ci/<workload>', () => {
      expectThrow(
        { 'release.yaml': github({ workload: 'release' }) },
        'a github-oidc workload is named ci-<job>'
      );
      // A ci-<job> name always means /ci, so a stored bundle never changes folder under one name.
      expectThrow(
        { 'ci-app.yaml': valid.replace('workload: app-one', 'workload: ci-app') },
        'only a github-oidc workload is named ci-<job>'
      );
      const index = loadPolicies({ 'ci-release.yaml': github({}), 'app-one.yaml': valid });
      const ci = index.get('production', 'ci-release');
      const app = index.get('production', 'app-one');
      if (ci === null || app === null) throw new Error('policies did not load');
      expect(bundleFolder(ci)).toEqual({ root: '/ci', path: '/ci/ci-release' });
      expect(bundleFolder(app)).toEqual({ root: '/workloads', path: '/workloads/app-one' });
      const entry = (path: string, name: string, value: string) => ({
        path,
        name,
        id: `${path}/${name}`,
        version: 1,
        value,
      });
      const resolved = resolveWorkloadSecrets(
        bundleFolder(ci).path,
        ['APP_ONE_SECRET', 'SHARED_ONE', 'NESTED_ONE'],
        {
          entries: [
            entry('/ci/ci-release', 'APP_ONE_SECRET', 'ci-value'),
            entry('/ci/ci-release/nested', 'NESTED_ONE', 'nested-value'),
            entry('/ci/minting', 'SHARED_ONE', 'minting-value'),
          ],
          refused: [],
        },
        { entries: [entry('/shared', 'SHARED_ONE', 'shared-value')], refused: [] }
      );
      expect(resolved).toEqual({
        secrets: {
          APP_ONE_SECRET: { value: 'ci-value', version: 1, id: '/ci/ci-release/APP_ONE_SECRET' },
          SHARED_ONE: { value: 'shared-value', version: 1, id: '/shared/SHARED_ONE' },
        },
        missing: ['NESTED_ONE'],
      });
    });
  });

  describe('vercel-oidc', () => {
    const vercel = (options: {
      workload?: string;
      environments: string;
      vercelEnvironments: string;
      extra?: string;
    }) => `
workload: ${options.workload ?? 'web'}
environments: ${options.environments}
identity:
  kind: vercel-oidc
  teamSlug: acme
  teamId: team_Acme1
  projectId: prj_Web1
  projectName: acme-web
  environments: ${options.vercelEnvironments}${options.extra ?? ''}
secrets: [APP_ONE_SECRET]
`;

    it('loads a project that maps production, preview and a custom environment', () => {
      const index = loadPolicies({
        'web.yaml': vercel({
          environments: '[production, staging, development]',
          vercelEnvironments: '[production, preview, { customEnvironmentId: env_S1 }]',
        }),
      });
      expect(index.get('production', 'web')?.identity).toMatchObject({
        kind: 'vercel-oidc',
        teamId: 'team_Acme1',
        projectId: 'prj_Web1',
      });
      expect(index.snapshot('production')[0]?.identity).toBe(
        'vercel-oidc|acme|team_Acme1|prj_Web1|acme-web|custom:env_S1,preview,production'
      );
    });

    it('derives the issuer from the team slug and refuses the team id form', () => {
      for (const issuer of ['https://oidc.vercel.com/team_Acme1', 'https://oidc.vercel.com/acme']) {
        expectThrow(
          {
            'web.yaml': vercel({
              environments: '[production]',
              vercelEnvironments: '[production]',
              extra: `\n  issuer: ${issuer}`,
            }),
          },
          'does not match the policy schema'
        );
      }
      expectThrow(
        {
          'web.yaml': vercel({
            environments: '[production]',
            vercelEnvironments: '[production]',
          }).replace('teamSlug: acme', 'teamSlug: team_Acme1'),
        },
        'does not match the policy schema'
      );
    });

    it('rejects the development environment, whose tokens belong to a person', () => {
      for (const vercelEnvironments of ['[development]', '[preview, development]']) {
        expectThrow(
          { 'web.yaml': vercel({ environments: '[development]', vercelEnvironments }) },
          'does not match the policy schema'
        );
      }
    });

    it('rejects unknown fields, malformed ids and a custom environment named by slug', () => {
      for (const source of [
        vercel({
          environments: '[production]',
          vercelEnvironments: '[production]',
          extra: '\n  vercelEnvironments: [production]',
        }),
        vercel({ environments: '[production]', vercelEnvironments: '[staging]' }),
        vercel({
          environments: '[staging]',
          vercelEnvironments: '[{ customEnvironmentSlug: staging }]',
        }),
        vercel({ environments: '[production]', vercelEnvironments: '[]' }),
      ]) {
        expectThrow({ 'web.yaml': source }, 'does not match the policy schema');
      }
      expectThrow(
        {
          'web.yaml': vercel({ environments: '[production]', vercelEnvironments: '[production]' })
            .replace('team_Acme1', 'acme')
            .replace('prj_Web1', 'web'),
        },
        'does not match the policy schema'
      );
    });

    it('lets only Vercel production read production values', () => {
      expectThrow(
        {
          'web.yaml': vercel({
            environments: '[production]',
            vercelEnvironments: '[production, preview]',
          }),
        },
        'Vercel environment preview may only read development, which the policy does not grant'
      );
      expectThrow(
        {
          'web.yaml': vercel({
            environments: '[production]',
            vercelEnvironments: '[{ customEnvironmentId: env_S1 }]',
          }),
        },
        'no listed Vercel environment may read production'
      );
    });

    it('maps preview only to development, custom environments only to staging', () => {
      expectThrow(
        {
          'web.yaml': vercel({
            environments: '[staging]',
            vercelEnvironments: '[preview]',
          }),
        },
        'no listed Vercel environment may read staging'
      );
      expectThrow(
        {
          'web.yaml': vercel({
            environments: '[development]',
            vercelEnvironments: '[production, preview]',
          }),
        },
        'Vercel environment production may only read production'
      );
      expectThrow(
        {
          'web.yaml': vercel({
            environments: '[development]',
            vercelEnvironments: '[{ customEnvironmentId: env_S1 }]',
          }),
        },
        'Vercel environment custom:env_S1 may only read staging, which the policy does not grant'
      );
      expect(() =>
        loadPolicies({
          'web.yaml': vercel({
            environments: '[staging, development]',
            vercelEnvironments: '[preview, { customEnvironmentId: env_S1 }]',
          }),
        })
      ).not.toThrow();
    });

    it('rejects a duplicate environment entry', () => {
      expectThrow(
        {
          'web.yaml': vercel({
            environments: '[staging]',
            vercelEnvironments:
              '[{ customEnvironmentId: env_S1 }, { customEnvironmentId: env_S1 }]',
          }),
        },
        'identity.environments contains a duplicate'
      );
    });

    it('binds one workload per Vercel project id', () => {
      expectThrow(
        {
          'web.yaml': vercel({ environments: '[production]', vercelEnvironments: '[production]' }),
          'web-preview.yaml': vercel({
            workload: 'web-preview',
            environments: '[development]',
            vercelEnvironments: '[preview]',
          }),
        },
        'declare the same identity'
      );
    });
  });

  it('rejects two workloads that declare the same identity', () => {
    const fly = (workload: string, app: string) => `
workload: ${workload}
environments: [production]
identity:
  kind: fly-oidc
  org: acme
  orgId: '10'
  app: ${app}
  appId: '20'
secrets: [APP_ONE_SECRET]
`;
    expectThrow(
      { 'one.yaml': fly('one', 'one'), 'two.yaml': fly('two', 'renamed') },
      'declare the same identity'
    );
  });
});

describe('policy index', () => {
  it('defaults to deny and filters by environment', () => {
    const index = loadPolicies({
      'app-one.yaml': valid,
      'app-two.yaml': `
workload: app-two
environments: [staging]
identity:
  kind: worker-binding
secrets: [APP_TWO_SECRET]
`,
    });
    expect(index.get('production', 'app-one')).not.toBeNull();
    expect(index.get('production', 'app-two')).toBeNull();
    expect(index.get('production', 'missing')).toBeNull();
    expect(index.forEnvironment('staging').map(policy => policy.workload)).toEqual(['app-two']);
    expect(index.has('app-two')).toBe(true);
    expect(index.has('missing')).toBe(false);
  });

  it('hashes the policy canonically and changes the hash with the policy', async () => {
    const first = loadPolicies({ 'app-one.yaml': valid });
    const second = loadPolicies({
      'app-one.yaml': valid.replace('APP_ONE_SECRET', 'APP_TWO_SECRET'),
    });
    const firstAgain = loadPolicies({ 'app-one.yaml': valid });
    expect(await first.hash('production')).toBe(await firstAgain.hash('production'));
    expect(await first.hash('production')).not.toBe(await second.hash('production'));
  });

  it('loads the shipped policies for the workloads STS serves', () => {
    const o11y = policyFor('production', 'o11y');
    expect(o11y?.identity.kind).toBe('worker-binding');
    expect([...(o11y?.secrets ?? [])].sort()).toEqual(
      [
        'O11Y_CF_AE_API_TOKEN',
        'O11Y_CF_CONTAINERS_API_TOKEN',
        'O11Y_KILO_GATEWAY_CLIENT_SECRET',
        'O11Y_SLACK_WEBHOOK_PAGE',
        'O11Y_SLACK_WEBHOOK_TICKET',
      ].sort()
    );
    const auditRelay = policyFor('production', 'audit-relay');
    expect([...(auditRelay?.secrets ?? [])].sort()).toEqual([
      'AUDIT_RELAY_AXIOM_TOKEN',
      'AUDIT_RELAY_SLACK_WEBHOOK_PAGE',
    ]);
    expect(policyIndex.has('audit-relay')).toBe(true);
    expect(policyFor('production', 'not-a-workload')).toBeNull();
  });

  it('binds ai-gateway to kilocode-ai-gateway production, staging and previews, with the UTS feed in development only', () => {
    const gateway = policyFor('production', 'ai-gateway');
    expect(gateway?.identity).toEqual({
      kind: 'vercel-oidc',
      teamSlug: 'kilocode',
      teamId: 'team_ItxRShuUkJaEd9GmXMEEgunb',
      projectId: 'prj_cFtsRYRBCm4qa8D35LC2j183FohC',
      projectName: 'kilocode-ai-gateway',
      environments: [
        'production',
        'preview',
        { customEnvironmentId: 'env_t9p3Xr8paMqpucgHbz0gg1Xrd4PV' },
      ],
    });
    for (const environment of ['staging', 'production'] as const) {
      expect(policyFor(environment, 'ai-gateway')).toMatchObject({
        environments: ['development', 'staging', 'production'],
        audiences: ['usage-ingest', 'o11y', 'ai-gateway-secure-proxy'],
        scopes: GATEWAY_BASE_SCOPES,
        secrets: [],
        dynamic: [],
        environmentGrants: {},
      });
    }
    expect(policyFor('development', 'ai-gateway')).toMatchObject({
      audiences: ['usage-ingest', 'o11y', 'ai-gateway-secure-proxy', 'uts-feed'],
      scopes: [...GATEWAY_BASE_SCOPES, 'uts-feed:revocation.read'],
      secrets: [],
      environmentGrants: {},
    });
  });
});

describe('dual-accept grants of the shipped policies', () => {
  /** Each dual-accept scope and the one set of workloads its receiver admits (default deny). */
  const CALLERS: Readonly<Record<string, readonly string[]>> = {
    'web:usage.record': ['usage-ingest'],
    'usage-ingest:usage.publish': ['ai-gateway', 'web'],
    'o11y:api-metrics.write': ['ai-gateway', 'web'],
    'o11y:alerting.read': ['web'],
    'o11y:alerting.write': ['web'],
    'ai-gateway-secure-proxy:request.forward': ['ai-gateway'],
  };

  it.each(['development', 'staging', 'production'] as const)(
    'grants each scope to exactly its callers and to no other policy in %s',
    environment => {
      const policies = policyIndex.forEnvironment(environment);
      for (const [scope, callers] of Object.entries(CALLERS)) {
        expect(
          policies
            .filter(policy => policy.scopes.includes(scope))
            .map(policy => policy.workload)
            .sort()
        ).toEqual(callers);
      }
    }
  );

  it.each(['staging', 'production'] as const)(
    'grants the callers only these scopes and audiences in %s',
    environment => {
      expect(policyFor(environment, 'usage-ingest')).toMatchObject({
        audiences: ['web'],
        scopes: ['web:sts.canary', 'web:usage.record'],
        secrets: [],
      });
      expect(policyFor(environment, 'web')).toMatchObject({
        audiences: ['usage-ingest', 'o11y'],
        scopes: WEB_BASE_SCOPES,
        secrets: [],
      });
      expect(policyFor(environment, 'ai-gateway')).toMatchObject({
        audiences: ['usage-ingest', 'o11y', 'ai-gateway-secure-proxy'],
        scopes: GATEWAY_BASE_SCOPES,
        secrets: [],
      });
    }
  );
});

describe('policy registrations', () => {
  const registration = `
workload: app-two
registered: true
secrets: []
`;
  const ENVIRONMENTS = ['development', 'staging', 'production'] as const;

  it('reserves a name that STS serves, admits, bundles, audits and hashes nothing for', async () => {
    const policiesOnly = loadPolicies({ 'app-one.yaml': valid });
    const index = loadPolicies({ 'app-one.yaml': valid, 'app-two.yaml': registration });
    expect(index.registered()).toEqual(['app-two']);
    expect(index.all()).toEqual(policiesOnly.all());
    expect(index.has('app-two')).toBe(false);
    for (const environment of ENVIRONMENTS) {
      expect(index.get(environment, 'app-two')).toBeNull();
      expect(index.forEnvironment(environment)).toEqual(policiesOnly.forEnvironment(environment));
      expect(index.snapshot(environment)).toEqual(policiesOnly.snapshot(environment));
      expect(await index.hash(environment)).toBe(await policiesOnly.hash(environment));
      for (const workload of ['app-one', 'app-two']) {
        expect(await index.workloadHash(environment, workload)).toBe(
          await policiesOnly.workloadHash(environment, workload)
        );
      }
    }
  });

  it('refuses any environment, identity, grant or secret, and registered other than true', () => {
    const refused = 'does not match the registration schema';
    for (const extra of [
      'environments: [production]\n',
      'identity:\n  kind: worker-binding\n',
      'audiences: [gateway]\n',
      "scopes: ['gateway:models.read']\n",
      'dynamic: []\n',
      'environmentGrants: {}\n',
      'owner: someone\n',
    ]) {
      expectThrow({ 'app-two.yaml': `${registration}${extra}` }, refused);
    }
    expectThrow(
      { 'app-two.yaml': registration.replace('secrets: []', 'secrets: [APP_TWO_SECRET]') },
      refused
    );
    expectThrow({ 'app-two.yaml': registration.replace('secrets: []\n', '') }, refused);
    expectThrow(
      { 'app-two.yaml': registration.replace('registered: true', 'registered: false') },
      refused
    );
    // A policy that also sets `registered` is read as a registration, so it is refused whole.
    expectThrow({ 'app-one.yaml': `${valid}registered: true\n` }, refused);
  });

  it('rejects a file whose name is not its workload', () => {
    expectThrow({ 'other.yaml': registration }, 'must be named app-two.yaml');
  });

  it('turns into a policy only by passing every policy check', () => {
    const converted = valid.replaceAll('app-one', 'app-two').replace('APP_ONE', 'APP_TWO');
    expect(loadPolicies({ 'app-two.yaml': converted }).get('production', 'app-two')).toMatchObject({
      secrets: ['APP_TWO_SECRET'],
    });
    expectThrow(
      { 'app-two.yaml': converted.replace('APP_TWO_SECRET', 'APP_TWO_SECRET_PROD') },
      'carries an environment suffix'
    );
  });

  it('refuses every shipped registration in every environment and keeps it out of the policies', () => {
    const active = policyIndex.all().map(policy => policy.workload);
    for (const workload of policyIndex.registered()) {
      expect(active).not.toContain(workload);
      expect(policyIndex.has(workload)).toBe(false);
      for (const environment of ENVIRONMENTS) {
        expect(policyFor(environment, workload)).toBeNull();
        expect(
          policyIndex.forEnvironment(environment).map(policy => policy.workload)
        ).not.toContain(workload);
        expect(policyIndex.snapshot(environment).map(entry => entry.workload)).not.toContain(
          workload
        );
      }
    }
  });
});

describe('policy lease grants', () => {
  const grant = (name: string, max: number, fallback: number, active: number) =>
    `  - grant: ${name}\n    maxTtlSeconds: ${max}\n    defaultTtlSeconds: ${fallback}\n    maxActive: ${active}\n`;
  const worker = (dynamic: string) => `${valid}dynamic:\n${dynamic}`;
  const github = (dynamic: string) => `
workload: ci-migrate
environments: [staging]
identity:
  kind: github-oidc
  repository: acme/repo
  repositoryId: '123'
  repositoryOwnerId: '456'
  environment: migrations
  jobWorkflowRefs: [acme/repo/.github/workflows/deploy.yml@refs/heads/main]
  events: [push]
secrets: []
dynamic:
${dynamic}`;

  it('accepts replica-read on a worker binding', () => {
    const index = loadPolicies({
      'app-one.yaml': worker(grant('replica-read', 9000, 3600, 2)),
    });
    expect(index.get('production', 'app-one')?.dynamic).toEqual([
      { grant: 'replica-read', maxTtlSeconds: 9000, defaultTtlSeconds: 3600, maxActive: 2 },
    ]);
    expect(index.snapshot('production').map(entry => entry.dynamic)).toEqual([
      ['replica-read:9000:3600:2'],
    ]);
  });

  it('knows no ci-migration grant', () => {
    const sources: Record<string, string>[] = [
      { 'app-one.yaml': worker(grant('ci-migration', 3600, 3600, 1)) },
      { 'ci-migrate.yaml': github(grant('ci-migration', 3600, 3600, 1)) },
    ];
    for (const source of sources) {
      expectThrow(source, 'does not match the policy schema');
    }
  });

  it('holds replica-read to a worker binding', () => {
    expectThrow(
      { 'ci-migrate.yaml': github(grant('replica-read', 3600, 3600, 1)) },
      'dynamic replica-read is only for a worker-binding policy'
    );
  });

  it('keeps lifetimes and active leases within the grant ceilings', () => {
    expectThrow(
      { 'app-one.yaml': worker(grant('replica-read', 28_801, 3600, 2)) },
      'dynamic replica-read: maxTtlSeconds is above 28800'
    );
    expectThrow(
      { 'app-one.yaml': worker(grant('replica-read', 3600, 7200, 2)) },
      'defaultTtlSeconds is above maxTtlSeconds'
    );
    expectThrow(
      { 'app-one.yaml': worker(grant('replica-read', 3600, 3600, 5)) },
      'dynamic replica-read: maxActive is above 4'
    );
    expectThrow(
      { 'app-one.yaml': worker(grant('replica-read', 3600, 60, 1)) },
      'does not match the policy schema'
    );
    expectThrow(
      {
        'app-one.yaml': worker(
          `${grant('replica-read', 3600, 3600, 1)}${grant('replica-read', 7200, 3600, 1)}`
        ),
      },
      'dynamic lists a grant twice'
    );
  });

  it('lists added and removed lease grants, with their limits, in the policy.changed event', () => {
    const before = loadPolicies({ 'app-one.yaml': worker(grant('replica-read', 3600, 3600, 1)) });
    const after = loadPolicies({ 'app-one.yaml': worker(grant('replica-read', 9000, 3600, 2)) });
    const event = policyChangedEvent({
      environment: 'production',
      policyHash: 'after',
      previousPolicyHash: 'before',
      previous: before.snapshot('production'),
      current: after.snapshot('production'),
    });
    expect(event.data.attributes).toMatchObject({
      addedDynamic: ['app-one:replica-read:9000:3600:2'],
      removedDynamic: ['app-one:replica-read:3600:3600:1'],
      dynamicTruncated: false,
    });
  });

  it('writes no dynamic field for a policy without lease grants, so a reader from before leases parses the snapshot', () => {
    const plain = loadPolicies({ 'app-one.yaml': valid });
    expect(plain.snapshot('production')[0]).not.toHaveProperty('dynamic');
    // The strict snapshot reader of the stacked base: the same schema without `dynamic`.
    const baseReader = PolicySnapshotSchema.element.omit({ dynamic: true }).array();
    expect(
      baseReader.safeParse(JSON.parse(JSON.stringify(plain.snapshot('production')))).success
    ).toBe(true);
    const leasing = loadPolicies({ 'app-one.yaml': worker(grant('replica-read', 3600, 3600, 1)) });
    expect(baseReader.safeParse(leasing.snapshot('production')).success).toBe(false);
    // The reader fills the token-grant lists a policy without token grants leaves out.
    expect(
      PolicySnapshotSchema.parse(JSON.parse(JSON.stringify(plain.snapshot('production'))))
    ).toEqual(plain.snapshot('production').map(entry => ({ audiences: [], scopes: [], ...entry })));
  });
});

describe('policy environment grants', () => {
  const allEnvironments = `
workload: app-one
environments: [development, staging, production]
identity:
  kind: worker-binding
secrets: [APP_ONE_SECRET]
audiences: [gateway]
scopes: ['gateway:models.read']
`;
  const developmentGrants = `environmentGrants:
  development:
    audiences: [o11y]
    scopes: ['o11y:alerts.read', 'gateway:usage.write']
    secrets: [APP_ONE_EXTRA]
`;
  const load = (source: string) =>
    loadPolicies({ 'app-one.yaml': source }, { scopeRegistry: REGISTRY });
  const expectEnvironmentThrow = (source: string, fragment: string) =>
    expect(() => load(source)).toThrow(fragment);

  it('adds a development grant where STS runs in development and nowhere else', async () => {
    const index = load(`${allEnvironments}${developmentGrants}`);
    expect(index.get('development', 'app-one')).toMatchObject({
      audiences: ['gateway', 'o11y'],
      scopes: ['gateway:models.read', 'o11y:alerts.read', 'gateway:usage.write'],
      secrets: ['APP_ONE_SECRET', 'APP_ONE_EXTRA'],
      environmentGrants: {},
    });
    expect(index.forEnvironment('development')[0]?.secrets).toContain('APP_ONE_EXTRA');
    const base = load(allEnvironments);
    for (const environment of ['staging', 'production'] as const) {
      expect(index.get(environment, 'app-one')).toMatchObject({
        audiences: ['gateway'],
        scopes: ['gateway:models.read'],
        secrets: ['APP_ONE_SECRET'],
        environmentGrants: {},
      });
      // The other environments keep the bundle, snapshot and hash of the policy without the grant.
      expect(await index.workloadHash(environment, 'app-one')).toBe(
        await base.workloadHash(environment, 'app-one')
      );
      expect(index.snapshot(environment)).toEqual(base.snapshot(environment));
      expect(await index.hash(environment)).toBe(await base.hash(environment));
    }
    expect(await index.workloadHash('development', 'app-one')).not.toBe(
      await base.workloadHash('development', 'app-one')
    );
    expect(await index.hash('development')).not.toBe(await base.hash('development'));
  });

  it('refuses a key outside environments, an empty entry and an unknown field', () => {
    expectEnvironmentThrow(
      `${valid}environmentGrants:\n  staging:\n    secrets: [APP_ONE_EXTRA]\n`,
      'environmentGrants.staging names an environment the policy does not list'
    );
    expectEnvironmentThrow(
      `${allEnvironments}environmentGrants:\n  development: {}\n`,
      'environmentGrants.development grants nothing'
    );
    expectEnvironmentThrow(
      `${allEnvironments}environmentGrants:\n  preview:\n    secrets: [APP_ONE_EXTRA]\n`,
      'does not match the policy schema'
    );
    expectEnvironmentThrow(
      `${allEnvironments}environmentGrants:\n  development:\n    dynamic: []\n`,
      'does not match the policy schema'
    );
  });

  it('holds an environment grant to every rule of a base grant', () => {
    const grant = (body: string) => `${allEnvironments}environmentGrants:\n  development:\n${body}`;
    expectEnvironmentThrow(
      grant(`    scopes: ['gateway:admin']\n`),
      'development: scope gateway:admin is not in STS_SCOPE_REGISTRY'
    );
    expectEnvironmentThrow(
      grant(`    scopes: ['o11y:alerts.read']\n`),
      'development: scope o11y:alerts.read belongs to audience o11y, which audiences does not list'
    );
    expectEnvironmentThrow(
      grant(`    audiences: [o11y]\n`),
      'development: audience o11y has no scope'
    );
    expectEnvironmentThrow(
      grant(`    audiences: [app-one]\n    scopes: ['app-one:read']\n`),
      'development: audience app-one is the workload itself'
    );
    expectEnvironmentThrow(
      grant(`    scopes: ['gateway:models.read']\n`),
      'development: scopes contains a duplicate'
    );
    expectEnvironmentThrow(
      grant(`    secrets: [APP_ONE_SECRET]\n`),
      'development: secrets contains a duplicate'
    );
    expectEnvironmentThrow(
      grant(`    secrets: [APP_ONE_EXTRA_STAGING]\n`),
      'development: secret APP_ONE_EXTRA_STAGING carries an environment suffix'
    );
    expectEnvironmentThrow(
      grant(`    secrets: [CLOUDFLARE_MINTING_TOKEN]\n`),
      'development: secret CLOUDFLARE_MINTING_TOKEN is a minting credential'
    );
  });

  it('refuses the reserved denied probe and its audience inside an environment grant, whatever the registry says', () => {
    // The registry lists the probe, so only its reservation can refuse it.
    const registry = {
      ...REGISTRY,
      canary: { scopes: ['canary:denied-probe', 'canary:other'] },
    };
    const grant = (body: string) => () =>
      loadPolicies(
        { 'app-one.yaml': `${allEnvironments}environmentGrants:\n  development:\n${body}` },
        { scopeRegistry: registry }
      );
    expect(grant(`    audiences: [canary]\n    scopes: ['canary:denied-probe']\n`)).toThrow(
      'development: scope canary:denied-probe is reserved and no policy may grant it'
    );
    expect(grant(`    audiences: [canary]\n    scopes: ['canary:other']\n`)).toThrow(
      'development: audience canary is reserved and no policy may grant it'
    );
    // The shipped registry lists the probe too, and the shipped web policy grants it nowhere.
    expect(() =>
      loadPolicies({
        'app-one.yaml': `${allEnvironments.replace(
          "audiences: [gateway]\nscopes: ['gateway:models.read']\n",
          ''
        )}environmentGrants:\n  development:\n    audiences: [canary]\n    scopes: ['canary:denied-probe']\n`,
      })
    ).toThrow('development: scope canary:denied-probe is reserved and no policy may grant it');
    for (const environment of ['development', 'staging', 'production'] as const) {
      expect(policyFor(environment, 'web')?.audiences).not.toContain('canary');
    }
  });

  it('stores the grants of its own environment merged into the lists a rollback reads', () => {
    const index = load(`${allEnvironments}${developmentGrants}`);
    const [entry] = index.snapshot('development');
    expect(entry).toEqual({
      workload: 'app-one',
      environments: ['development', 'production', 'staging'],
      identity: 'worker-binding',
      secrets: ['APP_ONE_EXTRA', 'APP_ONE_SECRET'],
      audiences: ['gateway', 'o11y'],
      scopes: ['gateway:models.read', 'gateway:usage.write', 'o11y:alerts.read'],
    });
    // The strict snapshot reader of the version before environment grants parses every entry.
    expect(
      PolicySnapshotSchema.safeParse(JSON.parse(JSON.stringify(index.snapshot('development'))))
        .success
    ).toBe(true);
  });

  it('grants web its UTS audiences, scopes and client keys in development only', () => {
    const development = policyFor('development', 'web');
    expect(development).toMatchObject({
      audiences: ['usage-ingest', 'o11y', 'uts-feed', 'uts'],
      scopes: [
        ...WEB_BASE_SCOPES,
        'uts-feed:revocation.read',
        'uts:subjects.revoke',
        'uts:browser-sessions.end',
        'uts:api-credentials.revoke',
      ],
      secrets: ['UTS_KILO_WEB_CLIENT_KEY', 'UTS_KILO_WEB_CLIENT_KEY_NEXT'],
    });
    for (const environment of ['staging', 'production'] as const) {
      expect(policyFor(environment, 'web')).toMatchObject({
        audiences: ['usage-ingest', 'o11y'],
        scopes: WEB_BASE_SCOPES,
        secrets: [],
      });
    }
  });
});
