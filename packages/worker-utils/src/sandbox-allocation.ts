import { z } from 'zod';

export const sandboxAllocationSchema = z.enum([
  'isolated-standard',
  'cloudflare-single',
  'cloudflare-shared',
  'vercel-small',
  'vercel-large',
]);

export type SandboxAllocation = z.infer<typeof sandboxAllocationSchema>;

export const SELECTABLE_SANDBOX_ALLOCATIONS = [
  'cloudflare-single',
  'cloudflare-shared',
  'vercel-small',
  'vercel-large',
] as const satisfies readonly SandboxAllocation[];

export type SelectableSandboxAllocation = (typeof SELECTABLE_SANDBOX_ALLOCATIONS)[number];

const cloudflareAllocationRequestSchema = z
  .object({
    provider: z.object({ id: z.literal('cloudflare'), account: z.literal('kilo') }).strict(),
    instanceType: z.enum(['single', 'shared', 'isolated-standard']),
  })
  .strict();

const vercelAllocationRequestSchema = z
  .object({
    provider: z.object({ id: z.literal('vercel'), account: z.enum(['kilo', 'byoc']) }).strict(),
    instanceType: z.enum(['small', 'large']),
  })
  .strict();

export const sandboxAllocationRequestSchema = z.union([
  cloudflareAllocationRequestSchema,
  vercelAllocationRequestSchema,
]);

export type SandboxAllocationRequest = z.infer<typeof sandboxAllocationRequestSchema>;

const selectableSandboxAllocationRequestSchema = z.union([
  cloudflareAllocationRequestSchema.extend({ instanceType: z.enum(['single', 'shared']) }),
  vercelAllocationRequestSchema,
]);

export type SelectableSandboxAllocationRequest = z.infer<
  typeof selectableSandboxAllocationRequestSchema
>;

const allocationRequests = {
  'isolated-standard': {
    provider: { id: 'cloudflare', account: 'kilo' },
    instanceType: 'isolated-standard',
  },
  'cloudflare-single': {
    provider: { id: 'cloudflare', account: 'kilo' },
    instanceType: 'single',
  },
  'cloudflare-shared': {
    provider: { id: 'cloudflare', account: 'kilo' },
    instanceType: 'shared',
  },
  'vercel-small': {
    provider: { id: 'vercel', account: 'kilo' },
    instanceType: 'small',
  },
  'vercel-large': {
    provider: { id: 'vercel', account: 'kilo' },
    instanceType: 'large',
  },
} as const satisfies Record<SandboxAllocation, SandboxAllocationRequest>;

export function getSandboxAllocationRequest<T extends SandboxAllocation>(allocation: T) {
  return allocationRequests[allocation];
}

export function getSandboxAllocationKey(allocation: SandboxAllocationRequest): string {
  return `${allocation.provider.id}:${allocation.provider.account}:${allocation.instanceType}`;
}

export function getKiloSandboxAllocation(
  request: SandboxAllocationRequest
): SandboxAllocation | undefined {
  const key = getSandboxAllocationKey(request);
  return sandboxAllocationSchema.options.find(
    allocation => getSandboxAllocationKey(allocationRequests[allocation]) === key
  );
}

export const sandboxAllocationInputSchema = z.union([
  sandboxAllocationRequestSchema,
  sandboxAllocationSchema.transform(allocation => getSandboxAllocationRequest(allocation)),
]);

export type SandboxAllocationInput = z.input<typeof sandboxAllocationInputSchema>;

export const selectableSandboxAllocationInputSchema = z.union([
  selectableSandboxAllocationRequestSchema,
  z
    .enum(SELECTABLE_SANDBOX_ALLOCATIONS)
    .transform(allocation => getSandboxAllocationRequest(allocation)),
]);

export const sandboxDestinationSchema = z.union([
  cloudflareAllocationRequestSchema.extend({
    instanceType: z.enum(['single', 'shared', 'isolated-standard', 'devcontainer']),
  }),
  vercelAllocationRequestSchema.extend({ instanceType: z.enum(['small', 'large', 'default']) }),
]);

export type SandboxDestination = z.infer<typeof sandboxDestinationSchema>;

export function isSelectableSandboxAllocation(
  allocation: SandboxAllocation | undefined
): allocation is SelectableSandboxAllocation {
  return (
    allocation !== undefined &&
    (SELECTABLE_SANDBOX_ALLOCATIONS as readonly string[]).includes(allocation)
  );
}

export const vercelSandboxResourcesSchema = z.union([
  z.object({ vcpus: z.literal(2), memory: z.literal(4096) }).strict(),
  z.object({ vcpus: z.literal(4), memory: z.literal(8192) }).strict(),
]);

export type VercelSandboxResources = z.infer<typeof vercelSandboxResourcesSchema>;

export function getSandboxAllocationProvider(
  allocation: SandboxAllocation
): 'cloudflare' | 'vercel' {
  return allocation.startsWith('vercel-') ? 'vercel' : 'cloudflare';
}

/**
 * Vercel sandboxes exist only on the control plane, so a Vercel allocation forces a
 * control-plane session regardless of `CONTROL_PLANE_IDS`. Cloudflare allocations pick
 * the sandbox shape only and leave the plane decision to that allowlist.
 */
export function sandboxAllocationRequiresControlPlane(
  allocation: SandboxAllocation | undefined
): boolean {
  return allocation !== undefined && getSandboxAllocationProvider(allocation) === 'vercel';
}

export function getSandboxAllocationResources(
  allocation: SandboxAllocation | undefined
): VercelSandboxResources | undefined {
  switch (allocation) {
    case 'vercel-small':
      return { vcpus: 2, memory: 4096 };
    case 'vercel-large':
      return { vcpus: 4, memory: 8192 };
    default:
      return undefined;
  }
}

export const sandboxSelectionCapabilitiesSchema = z
  .object({
    enabled: z.boolean(),
    defaultDestination: sandboxDestinationSchema.optional(),
    options: z.array(
      z.object({
        allocation: selectableSandboxAllocationInputSchema,
        available: z.boolean(),
        reason: z.string().optional(),
      })
    ),
  })
  .refine(value => value.enabled || value.options.length === 0, {
    message: 'Disabled sandbox selection must not expose options',
    path: ['options'],
  });

export type SandboxSelectionCapabilities = z.infer<typeof sandboxSelectionCapabilitiesSchema>;
