import { describe, expect, it } from 'vitest';
import { loadPolicies } from '../../src/policy/load';
import { policyIndex } from '../../src/policy';

const PRODUCTION_WORKFLOW =
  'Kilo-Org/cloud/.github/workflows/deploy-production.yml@refs/heads/main';

/** A trigger-only policy; each part can be replaced to break one rule. */
function triggerOnly(
  parts: {
    workload?: string;
    environments?: string;
    identity?: string;
    environment?: string;
    workflow?: string;
    events?: string;
    rest?: string;
  } = {}
): string {
  const identity =
    parts.identity ??
    `  kind: github-oidc
  repository: Kilo-Org/cloud
  repositoryId: '1145038391'
  repositoryOwnerId: '201822503'
${parts.environment ?? '  environment: production\n'}  refs: [refs/heads/main]
  jobWorkflowRefs: [${parts.workflow ?? PRODUCTION_WORKFLOW}]
  events: ${parts.events ?? '[workflow_run, schedule, workflow_dispatch]'}`;
  return `workload: ${parts.workload ?? 'ci-db-migrate'}
environments: ${parts.environments ?? '[production]'}
identity:
${identity}
${parts.rest ?? 'secrets: []\ndynamic:\n  - grant: migration-run\n'}`;
}

function expectThrow(sources: Record<string, string>, fragment: string): void {
  expect(() => loadPolicies(sources)).toThrow(fragment);
}

describe('migration-run policies', () => {
  it('ships ci-db-migrate, ci-db-migrate-staging and the migration-proxy Worker policy', () => {
    expect(policyIndex.get('production', 'ci-db-migrate')).toMatchObject({
      environments: ['production'],
      secrets: [],
      dynamic: [{ grant: 'migration-run' }],
      identity: {
        environment: 'production',
        refs: ['refs/heads/main'],
        jobWorkflowRefs: [PRODUCTION_WORKFLOW],
        events: ['workflow_run', 'schedule', 'workflow_dispatch'],
      },
    });
    expect(policyIndex.get('staging', 'ci-db-migrate-staging')).toMatchObject({
      environments: ['staging'],
      secrets: [],
      dynamic: [{ grant: 'migration-run' }],
      identity: {
        environment: 'staging',
        jobWorkflowRefs: ['Kilo-Org/cloud/.github/workflows/deploy-staging.yml@refs/heads/main'],
      },
    });
    for (const environment of ['staging', 'production'] as const) {
      expect(policyIndex.get(environment, 'migration-proxy')).toMatchObject({
        environments: ['staging', 'production'],
        identity: { kind: 'worker-binding' },
        secrets: ['MIGRATION_PROXY_DB_PASSWORD', 'MIGRATION_PROXY_GITHUB_APP_KEY'],
      });
    }
    expect(policyIndex.registered()).not.toContain('migration-proxy');
    expect(policyIndex.get('development', 'migration-proxy')).toBeNull();
  });

  it('accepts the trigger-only policy with workflow_run and production (Q71 carve-out)', () => {
    expect(loadPolicies({ 'ci-db-migrate.yaml': triggerOnly() }).has('ci-db-migrate')).toBe(true);
  });

  it('refuses migration-run with secrets, audiences, scopes, another grant or environment grants', () => {
    for (const rest of [
      'secrets: [DATABASE_URL]\ndynamic:\n  - grant: migration-run\n',
      "secrets: []\naudiences: [web]\nscopes: ['web:sts.canary']\ndynamic:\n  - grant: migration-run\n",
      'secrets: []\ndynamic:\n  - grant: migration-run\n  - grant: replica-read\n    maxTtlSeconds: 3600\n    defaultTtlSeconds: 3600\n    maxActive: 1\n',
      'secrets: []\ndynamic:\n  - grant: migration-run\nenvironmentGrants:\n  production:\n    secrets: [DATABASE_URL]\n',
    ]) {
      expectThrow(
        { 'ci-db-migrate.yaml': triggerOnly({ rest }) },
        'a policy with dynamic migration-run holds nothing else'
      );
    }
  });

  it('refuses migration-run with any other field', () => {
    expectThrow(
      {
        'ci-db-migrate.yaml': triggerOnly({
          rest: 'secrets: []\ndynamic:\n  - grant: migration-run\n    maxActive: 1\n',
        }),
      },
      'does not match the policy schema'
    );
  });

  it('refuses migration-run on a worker binding', () => {
    expectThrow(
      {
        'db-migrate.yaml': triggerOnly({
          workload: 'db-migrate',
          identity: '  kind: worker-binding',
        }),
      },
      'dynamic migration-run is only for a github-oidc policy'
    );
  });

  it('refuses migration-run without a GitHub environment', () => {
    expectThrow(
      {
        'ci-db-migrate.yaml': triggerOnly({
          environments: '[staging]',
          environment: '',
          events: '[schedule, workflow_dispatch]',
        }),
      },
      'a github-oidc policy with dynamic migration-run must bind identity.environment'
    );
  });

  it('keeps the Q71 rule for every other policy', () => {
    const rest = 'secrets: []\n';
    expectThrow(
      { 'ci-db-migrate.yaml': triggerOnly({ rest }) },
      'a github-oidc policy that accepts workflow_run cannot grant production'
    );
    expectThrow(
      { 'ci-db-migrate.yaml': triggerOnly({ rest }) },
      'a github-oidc policy that accepts workflow_run accepts no other event'
    );
    expectThrow(
      { 'ci-db-migrate.yaml': triggerOnly({ rest, events: '[workflow_run]' }) },
      'a github-oidc policy that accepts workflow_run cannot grant production'
    );
  });

  it('refuses a second policy with the ci-db-migrate identity', () => {
    expectThrow(
      {
        'ci-db-migrate.yaml': triggerOnly(),
        'ci-db-migrate-copy.yaml': triggerOnly({ workload: 'ci-db-migrate-copy' }),
      },
      'declare the same identity'
    );
  });

  it('refuses any other policy that names a trigger-only workflow file, in any environment', () => {
    expectThrow(
      {
        'ci-db-migrate.yaml': triggerOnly(),
        'ci-deploy-staging.yaml': triggerOnly({
          workload: 'ci-deploy-staging',
          environments: '[staging]',
          environment: '  environment: staging\n',
          events: '[workflow_dispatch]',
          rest: 'secrets: [DEPLOY_KEY]\n',
        }),
      },
      'workload ci-deploy-staging names a workflow file of the trigger-only workload ci-db-migrate'
    );
  });
});
