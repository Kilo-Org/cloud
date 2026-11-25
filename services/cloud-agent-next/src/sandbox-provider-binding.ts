import type { ByocVercelOwner } from './byoc/vercel-owner.js';
import { byocOwnerSchema, type ByocSource } from './byoc/owner.js';
import { z } from 'zod';

import type { AgentSandboxProvider } from './types.js';

export type SandboxProviderBinding =
  | { kind: 'aws'; source: { kind: 'byoc' } & ByocSource }
  | { kind: 'cloudflare' }
  | { kind: 'cloudflare-containers' }
  // Decode-only legacy binding. Runtime admission rejects retired platform Vercel.
  | { kind: 'vercel'; source: { kind: 'platform' } }
  | { kind: 'vercel'; source: { kind: 'byoc'; credentialId: string } & ByocVercelOwner };

export const SandboxProviderBindingSchema: z.ZodType<SandboxProviderBinding> = z.discriminatedUnion(
  'kind',
  [
    z
      .object({
        kind: z.literal('aws'),
        source: z.object({ kind: z.literal('byoc'), credentialId: z.uuid() }).and(byocOwnerSchema),
      })
      .strict(),
    z.object({ kind: z.literal('cloudflare') }).strict(),
    z.object({ kind: z.literal('cloudflare-containers') }).strict(),
    z
      .object({
        kind: z.literal('vercel'),
        source: z.union([
          z.object({ kind: z.literal('platform') }).strict(),
          z
            .object({
              kind: z.literal('byoc'),
              organizationId: z.string().min(1),
              credentialId: z.string().min(1),
            })
            .strict(),
          z
            .object({
              kind: z.literal('byoc'),
              userId: z.string().min(1),
              credentialId: z.string().min(1),
            })
            .strict(),
        ]),
      })
      .strict(),
  ]
) as z.ZodType<SandboxProviderBinding>;

export function bindingFromLegacyProvider(provider: AgentSandboxProvider): SandboxProviderBinding {
  if (provider === 'aws') throw new Error('AWS requires a customer connection');
  return provider === 'vercel'
    ? { kind: 'vercel', source: { kind: 'platform' } }
    : { kind: provider };
}

export function providerKindFromBinding(binding: SandboxProviderBinding): AgentSandboxProvider {
  return binding.kind;
}

export function sameSandboxProviderBinding(
  left: SandboxProviderBinding,
  right: SandboxProviderBinding
): boolean {
  if (left.kind !== right.kind) return false;
  if (
    (left.kind !== 'vercel' && left.kind !== 'aws') ||
    (right.kind !== 'vercel' && right.kind !== 'aws')
  )
    return true;
  if (left.source.kind !== right.source.kind) return false;
  if (left.source.kind !== 'byoc' || right.source.kind !== 'byoc') return true;
  if (left.source.credentialId !== right.source.credentialId) return false;
  if (left.source.organizationId !== undefined && right.source.organizationId !== undefined) {
    return left.source.organizationId === right.source.organizationId;
  }
  if (left.source.userId !== undefined && right.source.userId !== undefined) {
    return left.source.userId === right.source.userId;
  }
  return false;
}
