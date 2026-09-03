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
import { resolveVercelSandboxRuntimeConfig } from './vercel/vercel-runtime-config.js';
import { resolveByocVercelRuntimeConfig } from '../byoc/vercel-credential-resolver.js';

export function createAgentSandbox(
  env: Env,
  metadata: SessionMetadata,
  runtimeContext?: AgentSandboxRuntimeContext
): AgentSandbox {
  if (getSandboxProvider(metadata) === 'onprem') {
    throw new AgentSandboxUnavailableError(
      'On-prem sandboxes require the current control plane',
      'provider_not_configured'
    );
  }
  if (getSandboxProvider(metadata) === 'vercel') {
    const binding = getSandboxProviderBinding(metadata);
    const source = binding.kind === 'vercel' ? binding.source : undefined;
    if (source?.kind === 'byoc') {
      return new VercelAgentSandbox(metadata, undefined, runtimeContext, {
        resolveConfig: () =>
          resolveByocVercelRuntimeConfig(env, {
            organizationId: source.organizationId,
            credentialId: source.credentialId,
          }),
      });
    }
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
