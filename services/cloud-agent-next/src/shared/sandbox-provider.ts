import type { SandboxProviderId } from '@kilocode/worker-utils/sandbox-provider-capabilities';

/**
 * The sandbox providers. Dependency-free, so the wrapper can share it;
 * `agentSandboxProviderSchema` in `src/types.ts` is built from this list.
 */
export const AGENT_SANDBOX_PROVIDERS = ['cloudflare', 'vercel', 'cloudflare-containers'] as const;

export type AgentSandboxProvider = (typeof AGENT_SANDBOX_PROVIDERS)[number];

// Feature support lives in the worker-utils capability table, keyed by the
// same ids. Type-only import: the wrapper bundle never contains worker-utils.
type AssertNever<_T extends never> = true;
type _ProviderIdMissingDriftGuard = AssertNever<Exclude<AgentSandboxProvider, SandboxProviderId>>;
type _ProviderIdExtraDriftGuard = AssertNever<Exclude<SandboxProviderId, AgentSandboxProvider>>;

/** The V2 wrapper launch env names its provider here, for the agent rules. */
export const CONTROL_SANDBOX_PROVIDER_ENV = 'CONTROL_SANDBOX_PROVIDER';

export function parseAgentSandboxProvider(
  value: string | undefined
): AgentSandboxProvider | undefined {
  return AGENT_SANDBOX_PROVIDERS.find(provider => provider === value);
}

/**
 * How contained SCM credentials reach the sandbox: the Worker's outbound
 * proxy injects them, or the provider's network policy forwards them.
 */
export type CredentialTransport = 'outbound-proxy' | 'network-policy';

/**
 * Per-provider facts that are not product features. Feature support is in
 * `SANDBOX_PROVIDER_CAPABILITIES` (worker-utils); adapter construction is in
 * `control-plane/sandbox/provider-adapters.ts`.
 */
export type ProviderDescriptor = {
  /** Display label in sandbox status; one of `SandboxProviderLabelSchema`. */
  label: string;
  /**
   * Inbound ports the provider's own control server listens on inside a
   * sandbox. A preview must never proxy to these: fetching one would let a
   * preview request reach the sandbox control plane instead of the user's
   * dev server.
   */
  reservedPreviewPorts: readonly number[];
  /** Extra wrapper launch environment. */
  launchEnv: Readonly<Record<string, string>>;
  /** A session needs the customer's own provider credential (BYOC). */
  requiresCustomerCredential: boolean;
  /** The provider keeps stopped names, so each allocation pins a unique physical name. */
  uniqueAllocationName: boolean;
  credentialTransport: CredentialTransport;
  /** The runtime is retired and starts no new compute. */
  retired: boolean;
};

export const PROVIDER_DESCRIPTORS = {
  cloudflare: {
    label: 'Cloudflare',
    // The `@cloudflare/sandbox` control server runs on `SERVER_PORT` (3000)
    // from the base image entrypoint.
    reservedPreviewPorts: [3000],
    launchEnv: {},
    requiresCustomerCredential: false,
    uniqueAllocationName: false,
    credentialTransport: 'outbound-proxy',
    retired: true,
  },
  vercel: {
    label: 'Vercel',
    // Vercel reserves 23456 for its runtime.
    reservedPreviewPorts: [23456],
    // The Vercel node24 snapshot installs Bun and global CLIs in /usr/local/bin.
    // Supply the runtime path directly instead of reading a snapshot's login profile.
    launchEnv: {
      PATH: '/usr/local/bin:/vercel/runtimes/node24/bin:/usr/local/sbin:/usr/sbin:/usr/bin:/sbin:/bin',
    },
    requiresCustomerCredential: true,
    uniqueAllocationName: true,
    credentialTransport: 'network-policy',
    retired: false,
  },
  'cloudflare-containers': {
    label: 'Cloudflare Containers',
    // The image exposes 3000, but nothing listens on it: the supervisor is
    // the container main process.
    reservedPreviewPorts: [],
    launchEnv: {},
    requiresCustomerCredential: false,
    uniqueAllocationName: false,
    credentialTransport: 'outbound-proxy',
    retired: false,
  },
} as const satisfies Readonly<Record<AgentSandboxProvider, ProviderDescriptor>>;

export function providerUsesOutboundCredentialProxy(provider: AgentSandboxProvider): boolean {
  return PROVIDER_DESCRIPTORS[provider].credentialTransport === 'outbound-proxy';
}
