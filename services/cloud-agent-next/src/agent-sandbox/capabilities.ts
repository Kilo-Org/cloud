import type { AgentSandboxProvider } from '../types.js';
import { sessionPlaneFromId } from '../session-plane.js';

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
  vercel: { terminal: false, devcontainer: false },
};

export function sessionHasTerminal(
  sessionId: string,
  provider: AgentSandboxProvider = 'cloudflare'
): boolean {
  return sessionPlaneFromId(sessionId) === 'control' || PROVIDER_CAPABILITIES[provider].terminal;
}
