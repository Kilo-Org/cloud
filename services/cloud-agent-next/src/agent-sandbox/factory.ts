import { VERCEL_BYOC_REQUIRED_MESSAGE } from '../byoc/vercel-owner.js';
import {
  getSandboxProvider,
  getSandboxProviderBinding,
  type SessionMetadata,
} from '../persistence/session-metadata.js';
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
import { resolveByocVercelRuntimeConfig } from '../byoc/vercel-credential-resolver.js';

export function createAgentSandbox(
  env: Env,
  metadata: SessionMetadata,
  runtimeContext?: AgentSandboxRuntimeContext
): AgentSandbox {
  if (getSandboxProvider(metadata) === 'vercel') {
    const binding = getSandboxProviderBinding(metadata);
    const source = binding.kind === 'vercel' ? binding.source : undefined;
    if (source?.kind === 'byoc') {
      return new VercelAgentSandbox(metadata, undefined, runtimeContext, {
        resolveConfig: () => resolveByocVercelRuntimeConfig(env, source),
      });
    }
    throw new AgentSandboxUnavailableError(VERCEL_BYOC_REQUIRED_MESSAGE, 'provider_not_configured');
  }
  if (getSandboxProvider(metadata) === 'cloudflare-containers') {
    throw new AgentSandboxUnavailableError(
      'Cloudflare containers are not available on the legacy agent plane',
      'capability_unavailable'
    );
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
