import type { AgentSandboxProvider } from './types.js';

/**
 * Whether a provider can enforce compute billing. This is a provider-support
 * decision, not a meter query: a provider that cannot enforce admission must
 * never be chosen as the default for an owner under enforcement.
 */
export function providerSupportsEnforcedBilling(provider: AgentSandboxProvider): boolean {
  switch (provider) {
    case 'cloudflare':
    case 'cloudflare-containers':
      return true;
    case 'vercel':
      return false;
  }
}
