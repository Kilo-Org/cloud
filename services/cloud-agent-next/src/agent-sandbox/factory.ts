import { getSandboxProvider, type SessionMetadata } from '../persistence/session-metadata.js';
import type { Env } from '../types.js';
import {
  AgentSandboxUnavailableError,
  type AgentSandbox,
  type AgentSandboxLifecycle,
  type AgentSandboxLifecycleHost,
  type AgentSandboxRuntimeContext,
} from './protocol.js';
import { CloudflareAgentSandbox } from './cloudflare/cloudflare-agent-sandbox.js';
import { VercelAgentSandbox } from './vercel/vercel-agent-sandbox.js';
import { VercelSandboxLifecycle } from './vercel/vercel-lifecycle.js';
import { resolveVercelSandboxRuntimeConfig } from './vercel/vercel-runtime-config.js';

export function createAgentSandbox(
  env: Env,
  metadata: SessionMetadata,
  runtimeContext?: AgentSandboxRuntimeContext
): AgentSandbox {
  if (getSandboxProvider(metadata) === 'vercel') {
    const config = resolveVercelSandboxRuntimeConfig(env, metadata.workspace?.providerRuntime);
    if (!config) {
      throw new AgentSandboxUnavailableError(
        'Vercel sandbox operational configuration is incomplete',
        'provider_not_configured'
      );
    }
    return new VercelAgentSandbox(metadata, config, runtimeContext);
  }
  return new CloudflareAgentSandbox(env, metadata);
}

/**
 * Vercel is the only provider with asynchronous create/deletion
 * reconciliation; its methods self-guard on stored intent state, so sessions
 * on other providers reduce to no-ops. Providers that add reconciled state
 * extend this to dispatch on it.
 */
export function createAgentSandboxLifecycle(
  env: Env,
  host: AgentSandboxLifecycleHost
): AgentSandboxLifecycle {
  return new VercelSandboxLifecycle(env, host);
}
