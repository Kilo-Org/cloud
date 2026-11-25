import { describe, expect, it } from 'vitest';
import { policyChangedEvent } from '../../src/audit/events';
import { loadPolicies } from '../../src/policy/load';
import { policyFor, policyIndex } from '../../src/policy';

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

  it('rejects the Vercel identity kind, which needs the audience exchange first', () => {
    expectThrow(
      {
        'web.yaml': `
workload: web
environments: [production]
identity:
  kind: vercel-oidc
  teamSlug: acme
  projectId: prj_web
  vercelEnvironments: [production]
secrets: [APP_ONE_SECRET]
`,
      },
      'does not match the policy schema'
    );
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
