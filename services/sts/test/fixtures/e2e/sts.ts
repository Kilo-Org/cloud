import { SecretsBroker } from '../../../src/broker';
import type { Env } from '../../../src/env';
import { handleRequest } from '../../../src/http';
import { BundleDO as StsBundleDO, RefresherDO as StsRefresherDO } from '../../../src/index';
import { loadPolicies } from '../../../src/policy/load';
import type { MintAuthority } from '../../../src/tokens/mint';
import { E2E_SCOPES } from './scopes';

export { DenialDO, DeployTokenDO, LeaseDO, SignerDO, TokenSignerDO } from '../../../src/index';

/**
 * Test-only build of STS for the local end-to-end checks (README "Tests"); never deployed. It runs
 * STS's own routes, broker and Durable Objects, with three changes: mints are checked against the
 * end-to-end registry; the policies are the probe's and four CI jobs'; and requests to GitHub's
 * issuer, to the manager and to Cloudflare's API go to the local fake that `ci-bundle-check.ts`,
 * `lease-check.ts` or `deploy-token-check.ts` serves on port 8830.
 */
const E2E_POLICIES = loadPolicies(
  {
    'secrets-broker-e2e-probe.yaml': `
workload: secrets-broker-e2e-probe
environments: [development]
identity:
  kind: worker-binding
secrets: []
audiences: [e2e-alpha, e2e-beta]
scopes: ['e2e-alpha:probe.read', 'e2e-beta:probe.read']
dynamic:
  - grant: replica-read
    maxTtlSeconds: 9000
    defaultTtlSeconds: 3600
    maxActive: 2
`,
    'ci-e2e-release.yaml': `
workload: ci-e2e-release
environments: [development]
identity:
  kind: github-oidc
  repository: kilo-e2e/ci-fixture
  repositoryId: '1001'
  repositoryOwnerId: '2002'
  environment: release
  jobWorkflowRefs: [kilo-e2e/ci-fixture/.github/workflows/publish.yml@refs/heads/main]
  events: [workflow_dispatch]
secrets: [E2E_RELEASE_KEY, E2E_SHARED_WEBHOOK]
`,
    'ci-e2e-migrate.yaml': `
workload: ci-e2e-migrate
environments: [development]
identity:
  kind: github-oidc
  repository: kilo-e2e/ci-fixture
  repositoryId: '1001'
  repositoryOwnerId: '2002'
  environment: migrations
  jobWorkflowRefs: [kilo-e2e/ci-fixture/.github/workflows/deploy.yml@refs/heads/main]
  events: [push]
secrets: []
dynamic:
  - grant: ci-migration
    maxTtlSeconds: 3600
    defaultTtlSeconds: 3600
    maxActive: 1
`,
    'ci-e2e-deploy.yaml': `
workload: ci-e2e-deploy
environments: [development]
identity:
  kind: github-oidc
  repository: kilo-e2e/ci-fixture
  repositoryId: '1001'
  repositoryOwnerId: '2002'
  environment: production
  jobWorkflowRefs: [kilo-e2e/ci-fixture/.github/workflows/cf-deploy.yml@refs/heads/main]
  events: [push]
secrets: []
dynamic:
  - grant: cloudflare-deploy
    permissionSet: e2e-deploy
    permissionGroups:
      - { id: 'e2e0000000000000000000000000a001', name: Workers Scripts Write, scope: account }
      - { id: 'e2e0000000000000000000000000a002', name: Containers Write, scope: account }
      - { id: 'e2e0000000000000000000000000a003', name: Workers Routes Write, scope: zone }
    zones: ['e2e0000000000000000000000000c001']
    intendedScripts: [e2e-worker]
    maxActive: 3
    maxPerHour: 12
`,
    'ci-e2e-deploy-short.yaml': `
workload: ci-e2e-deploy-short
environments: [development]
identity:
  kind: github-oidc
  repository: kilo-e2e/other-fixture
  repositoryId: '1003'
  repositoryOwnerId: '2002'
  environment: production
  jobWorkflowRefs: [kilo-e2e/other-fixture/.github/workflows/cf-deploy.yml@refs/heads/main]
  events: [push]
secrets: []
dynamic:
  - grant: cloudflare-deploy
    permissionSet: e2e-short
    permissionGroups:
      - { id: 'e2e0000000000000000000000000a001', name: Workers Scripts Write, scope: account }
    intendedScripts: [e2e-other-worker]
    ttlSeconds: 300
    maxActive: 1
    maxPerHour: 4
`,
  },
  { scopeRegistry: E2E_SCOPES }
);

const E2E_AUTHORITY: MintAuthority = { scopes: E2E_SCOPES, policies: E2E_POLICIES };

const FAKE_ORIGINS: Record<string, string> = {
  'https://token.actions.githubusercontent.com': 'http://127.0.0.1:8830/github',
  'https://manager.sts-test.invalid': 'http://127.0.0.1:8830/manager',
  'https://api.cloudflare.com': 'http://127.0.0.1:8830/cloudflare',
};

const upstreamFetch = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const request = new Request(input, init);
  const url = new URL(request.url);
  const fake = FAKE_ORIGINS[url.origin];
  if (fake === undefined) return await upstreamFetch(request);
  return await upstreamFetch(new Request(`${fake}${url.pathname}${url.search}`, request));
};

export class E2eSecretsBroker extends SecretsBroker {
  static override readonly mintAuthority = E2E_AUTHORITY;
}

export class BundleDO extends StsBundleDO {
  static override readonly policies = E2E_POLICIES;
}

export class RefresherDO extends StsRefresherDO {
  static override readonly policies = E2E_POLICIES;
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx, E2E_AUTHORITY),
} satisfies ExportedHandler<Env>;
