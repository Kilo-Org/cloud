/**
 * The sandbox providers. Dependency-free, so the wrapper can share it;
 * `agentSandboxProviderSchema` in `src/types.ts` is built from this list.
 */
export const AGENT_SANDBOX_PROVIDERS = ['cloudflare', 'vercel', 'cloudflare-containers'] as const;

export type AgentSandboxProvider = (typeof AGENT_SANDBOX_PROVIDERS)[number];

/** The V2 wrapper launch env names its provider here, for the agent rules. */
export const CONTROL_SANDBOX_PROVIDER_ENV = 'CONTROL_SANDBOX_PROVIDER';

export function parseAgentSandboxProvider(
  value: string | undefined
): AgentSandboxProvider | undefined {
  return AGENT_SANDBOX_PROVIDERS.find(provider => provider === value);
}
