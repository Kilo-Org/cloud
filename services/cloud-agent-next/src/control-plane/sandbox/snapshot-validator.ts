import { byocVercelOwnerSchema, byocVercelOwnerFields } from '../../byoc/vercel-owner.js';
import { z } from 'zod';
import {
  decodeVercelProviderRef,
  vercelProviderLocatorSchema,
} from '../../sandbox-control/vercel-provider.js';
import { initialAllocationState, type AllocationState } from './allocation.js';
import type { StoredProviderPin } from './sandbox-do.js';

export const SNAPSHOT_VALIDATOR_REF_KEY = 'byoc_snapshot_validator_ref';
export const snapshotValidatorInputSchema = z
  .object({
    build: z.object({ credentialId: z.uuid(), generation: z.uuid() }).and(byocVercelOwnerSchema),
    allocation: z
      .object({
        providerRef: z.string().min(1),
        locator: vercelProviderLocatorSchema,
        createdAt: z.number().finite(),
        expiresAt: z.number().finite(),
      })
      .strict(),
    credentialHash: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export type SnapshotValidatorInput = z.infer<typeof snapshotValidatorInputSchema>;

/** Adopt only the external sandbox identified by this build generation. */
export function snapshotValidatorAllocation(
  sandboxId: string,
  input: SnapshotValidatorInput,
  now: number
): { pin: StoredProviderPin; state: AllocationState } {
  const reference = decodeVercelProviderRef(input.allocation.providerRef);
  if (
    sandboxId !== `ses-byoc-validator-${input.build.generation.replaceAll('-', '')}` ||
    !reference ||
    input.allocation.expiresAt <= Math.max(now, input.allocation.createdAt)
  ) {
    throw new Error('Snapshot validator identity mismatch');
  }
  return {
    pin: {
      provider: 'vercel',
      allocationName: reference.sandboxName,
      configuration: { provider: 'vercel' },
      locator: input.allocation.locator,
      billing: null,
      containment: null,
      byoc: { ...byocVercelOwnerFields(input.build), credentialId: input.build.credentialId },
    },
    state: {
      ...initialAllocationState(),
      kind: 'starting',
      allocationId: input.build.generation,
      providerRef: input.allocation.providerRef,
      firstConnectDeadlineAt: input.allocation.expiresAt,
    },
  };
}
