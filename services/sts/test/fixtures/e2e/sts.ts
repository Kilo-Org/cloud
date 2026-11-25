import { SecretsBroker } from '../../../src/broker';
import type { Env } from '../../../src/env';
import { handleRequest } from '../../../src/http';
import { loadPolicies } from '../../../src/policy/load';
import type { MintAuthority } from '../../../src/tokens/mint';
import { E2E_SCOPES } from './scopes';

export { BundleDO, DenialDO, RefresherDO, SignerDO, TokenSignerDO } from '../../../src/index';

/**
 * Test-only build of STS for the local end-to-end check (README "Tests"); never deployed. It runs
 * STS's own routes, broker and Durable Objects, with one change: the shipped scope registry lists
 * no scope yet, so mints are checked against the end-to-end registry and the probe's policy.
 */
const E2E_AUTHORITY: MintAuthority = {
  scopes: E2E_SCOPES,
  policies: loadPolicies(
    {
      'secrets-broker-e2e-probe.yaml': `
workload: secrets-broker-e2e-probe
environments: [development]
identity:
  kind: worker-binding
secrets: []
audiences: [e2e-alpha, e2e-beta]
scopes: ['e2e-alpha:probe.read', 'e2e-beta:probe.read']
`,
    },
    { scopeRegistry: E2E_SCOPES }
  ),
};

export class E2eSecretsBroker extends SecretsBroker {
  protected override mintAuthority(): MintAuthority {
    return E2E_AUTHORITY;
  }
}

export default {
  fetch: (request, env, ctx) => handleRequest(request, env, ctx, E2E_AUTHORITY),
} satisfies ExportedHandler<Env>;
