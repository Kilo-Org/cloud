import { describe, expect, it } from 'vitest';
import { policyChangedEvent } from '../../src/audit/events';
import { resolveWorkloadSecrets } from '../../src/bundle/resolve';
import { loadPolicies } from '../../src/policy/load';
import { policyFor, policyIndex } from '../../src/policy';
import { bundleFolder } from '../../src/policy/schema';

const REGISTRY = {
  gateway: { scopes: ['gateway:models.read', 'gateway:usage.write'] },
  o11y: { scopes: ['o11y:alerts.read'] },
};

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

  it('refuses an audience equal to the workload, duplicates, and any dynamic grant', () => {
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
  });

  it('checks shipped policies against the shipped registry, which lists no scope yet', () => {
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
      previous: before.snapshot(),
      current: after.snapshot(),
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
      identity?: string;
      workflows?: string;
      events?: string;
      extra?: string;
    }) => `
workload: ${options.workload ?? 'ci-release'}
environments: ${options.environments ?? '[production]'}
identity:
  kind: github-oidc
  repository: acme/repo
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
      expect(index.snapshot().map(entry => entry.identity)).toEqual([
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
        loadPolicies({ 'ci-release.yaml': github({ events: '[workflow_run]' }) })
      ).not.toThrow();
      expectThrow(
        { 'ci-release.yaml': github({ events: '[workflow_run, push]' }) },
        'a github-oidc policy that accepts workflow_run accepts no other event'
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
      expect(index.snapshot()[0]?.identity).toBe(
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
    expect(await first.hash()).toBe(await firstAgain.hash());
    expect(await first.hash()).not.toBe(await second.hash());
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
});
