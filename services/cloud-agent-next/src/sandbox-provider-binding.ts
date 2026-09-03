import { z } from 'zod';

import type { AgentSandboxProvider } from './types.js';
import {
  onPremProviderBindingSchema,
  type OnPremProviderBinding,
} from './shared/onprem-protocol.js';

export type SandboxProviderBinding =
  | OnPremProviderBinding
  | { kind: 'cloudflare' }
  | { kind: 'vercel'; source: { kind: 'platform' } }
  | {
      kind: 'vercel';
      source: {
        kind: 'byoc';
        organizationId: string;
        credentialId: string;
      };
    };

export const SandboxProviderBindingSchema: z.ZodType<SandboxProviderBinding> = z.discriminatedUnion(
  'kind',
  [
    onPremProviderBindingSchema,
    z.object({ kind: z.literal('cloudflare') }).strict(),
    z
      .object({
        kind: z.literal('vercel'),
        source: z.discriminatedUnion('kind', [
          z.object({ kind: z.literal('platform') }).strict(),
          z
            .object({
              kind: z.literal('byoc'),
              organizationId: z.string().min(1),
              credentialId: z.string().min(1),
            })
            .strict(),
        ]),
      })
      .strict(),
  ]
) as z.ZodType<SandboxProviderBinding>;

export function bindingFromLegacyProvider(provider: AgentSandboxProvider): SandboxProviderBinding {
  if (provider === 'onprem') {
    throw new Error('On-prem sandboxes require an explicit provider binding');
  }
  return provider === 'vercel'
    ? { kind: 'vercel', source: { kind: 'platform' } }
    : { kind: 'cloudflare' };
}

export function isManagedContainerBillingExempt(binding: SandboxProviderBinding): boolean {
  return binding.kind === 'onprem' || (binding.kind === 'vercel' && binding.source.kind === 'byoc');
}

export function providerKindFromBinding(binding: SandboxProviderBinding): AgentSandboxProvider {
  return binding.kind;
}

export function sameSandboxProviderBinding(
  left: SandboxProviderBinding,
  right: SandboxProviderBinding
): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === 'onprem' && right.kind === 'onprem') {
    return (
      left.organizationId.toLowerCase() === right.organizationId.toLowerCase() &&
      left.installationId.toLowerCase() === right.installationId.toLowerCase() &&
      left.profileId === right.profileId
    );
  }
  if (left.kind !== 'vercel' || right.kind !== 'vercel') return true;
  if (left.source.kind !== right.source.kind) return false;
  if (left.source.kind !== 'byoc' || right.source.kind !== 'byoc') return true;
  return (
    left.source.organizationId === right.source.organizationId &&
    left.source.credentialId === right.source.credentialId
  );
}
