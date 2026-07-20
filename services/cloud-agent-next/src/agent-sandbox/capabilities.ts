import type { AgentSandboxProvider } from '../types.js';

export type ProviderCapabilities = {
  terminal: boolean;
  devcontainer: boolean;
};

/**
 * Static capability matrix per sandbox provider. Metadata validation and
 * feature gates read this table instead of hard-coding provider names.
 */
export const PROVIDER_CAPABILITIES: Record<AgentSandboxProvider, ProviderCapabilities> = {
  cloudflare: { terminal: true, devcontainer: true },
};
