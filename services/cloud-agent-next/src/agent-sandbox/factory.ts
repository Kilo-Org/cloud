import type { SessionMetadata } from '../persistence/session-metadata.js';
import type { Env } from '../types.js';
import type { AgentSandbox, AgentSandboxLifecycle, AgentSandboxLifecycleHost } from './protocol.js';
import { CloudflareAgentSandbox } from './cloudflare/cloudflare-agent-sandbox.js';

export function createAgentSandbox(env: Env, metadata: SessionMetadata): AgentSandbox {
  return new CloudflareAgentSandbox(env, metadata);
}

/**
 * Provider-side lifecycle reconciliation seam. Cloudflare runtimes are
 * locally addressed, so creation never needs reconciliation and deletion is
 * driven synchronously by the session; providers whose runtimes are created
 * or deleted through remote APIs dispatch to their own lifecycle here.
 */
export function createAgentSandboxLifecycle(
  _env: Env,
  _host: AgentSandboxLifecycleHost
): AgentSandboxLifecycle {
  return {
    reconcileCreateIntent: async () => undefined,
    planDeletion: async () => ({ kind: 'not-applicable' }),
    reconcilePendingDeletion: async () => 'none',
  };
}
