import type { AgentSandboxProvider } from './sandbox-provider.js';

/**
 * Inbound ports the provider's own control server listens on inside a sandbox.
 * A preview must never proxy to these: fetching one would let a preview request
 * reach the sandbox control plane instead of the user's dev server.
 *
 * `cloudflare` runs the `@cloudflare/sandbox` control server on `SERVER_PORT`
 * (3000) from the base image entrypoint. `vercel` reserves 23456 for its
 * runtime. `cloudflare-containers` exposes 3000 in the image but nothing
 * listens on it (the supervisor is the container main process).
 */
const RESERVED_PREVIEW_PORTS: Record<AgentSandboxProvider, readonly number[]> = {
  cloudflare: [3000],
  vercel: [23456],
  'cloudflare-containers': [],
};

export function reservedPreviewPorts(provider: AgentSandboxProvider): readonly number[] {
  return RESERVED_PREVIEW_PORTS[provider];
}

export function isReservedPreviewPort(provider: AgentSandboxProvider, port: number): boolean {
  return RESERVED_PREVIEW_PORTS[provider].includes(port);
}
