import { describe, expect, it } from 'vitest';
import { loadPolicies } from '../../src/policy/load';
import { policyFor, policyIndex } from '../../src/policy';

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

  it('rejects a GitHub identity that binds neither environments nor refs', () => {
    expectThrow(
      {
        'gh.yaml': `
workload: gh
environments: [staging]
identity:
  kind: github-oidc
  repositoryId: '1'
  repositoryOwnerId: '2'
secrets: [APP_ONE_SECRET]
`,
      },
      'binds environments, refs, or both'
    );
  });

  it('requires a GitHub environment binding for a policy that grants production', () => {
    expectThrow(
      {
        'gh.yaml': `
workload: gh
environments: [production]
identity:
  kind: github-oidc
  repositoryId: '1'
  repositoryOwnerId: '2'
  refs: [refs/heads/main]
secrets: [APP_ONE_SECRET]
`,
      },
      'must bind identity.environments'
    );
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
