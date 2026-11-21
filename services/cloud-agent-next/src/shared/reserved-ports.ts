import { PROVIDER_DESCRIPTORS, type AgentSandboxProvider } from './sandbox-provider.js';

/** See `ProviderDescriptor.reservedPreviewPorts`. */
export function reservedPreviewPorts(provider: AgentSandboxProvider): readonly number[] {
  return PROVIDER_DESCRIPTORS[provider].reservedPreviewPorts;
}

export function isReservedPreviewPort(provider: AgentSandboxProvider, port: number): boolean {
  return reservedPreviewPorts(provider).includes(port);
}
