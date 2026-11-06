import type { VercelSandboxNetworkPolicy } from '../agent-sandbox/vercel/vercel-sandbox-rest-client.js';
import type { SessionCredentialGrant } from '../sandbox-control/session-credentials.js';
import { configuredVercelForwardUrl, managedScmForwardingTargets } from './targets.js';
import {
  verifiedVercelSandboxIdentityContract,
  VercelScmContainmentError,
} from './vercel-identity.js';

export function addVercelScmForwarding(
  policy: VercelSandboxNetworkPolicy,
  grants: readonly SessionCredentialGrant[],
  env: { WORKER_URL?: string }
): VercelSandboxNetworkPolicy {
  const targets = managedScmForwardingTargets(grants);
  if (targets.length === 0) return policy;
  const forwardURL = configuredVercelForwardUrl(env, grants[0]?.sandboxId ?? '');
  if (!verifiedVercelSandboxIdentityContract || !forwardURL) throw new VercelScmContainmentError();
  const allow: VercelSandboxNetworkPolicy['allow'] = { ...policy.allow };
  const hostnames = new Set(targets.map(target => new URL(`https://${target}`).hostname));
  for (const hostname of hostnames) {
    // Legacy and explicit transforms keep their first-match behavior.
    allow[hostname] = [...(allow[hostname] ?? []), { forwardURL }];
  }
  return { allow };
}
