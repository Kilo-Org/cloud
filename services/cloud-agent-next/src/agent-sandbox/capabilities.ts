import type { AgentSandboxProvider } from '../types.js';

export type ProviderCapabilities = {
  outboundCredentialProxy: boolean;
};

/**
 * Static capability matrix per sandbox provider. Metadata validation and
 * feature gates read this table instead of hard-coding provider names.
 */
export const PROVIDER_CAPABILITIES: Record<AgentSandboxProvider, ProviderCapabilities> = {
  cloudflare: { outboundCredentialProxy: true },
  vercel: { outboundCredentialProxy: false },
  'cloudflare-containers': { outboundCredentialProxy: true },
};

export function providerUsesOutboundCredentialProxy(provider: AgentSandboxProvider): boolean {
  return PROVIDER_CAPABILITIES[provider].outboundCredentialProxy;
}
