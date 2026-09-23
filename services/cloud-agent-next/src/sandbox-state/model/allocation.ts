/**
 * Allocation machine (design §5). Provider-level existence only; it never decides
 * whether the runtime is usable. The canonical schema is the stored shape written
 * under `sandbox_allocation_state`.
 *
 * The legacy `PhysicalRecord` decoder must preserve fields the lossy durable-state
 * schema dropped (`allocationName`, `vercel`, `containment`,
 * `stopTombstone.wrapperInstanceId`); those live on `AllocationTarget` and
 * `AllocationStopIntent` here.
 */
import { z } from 'zod';
import { onPremProviderBindingSchema, onPremProfileSchema } from '../../shared/onprem-protocol.js';
import { healthStateSchema, type ConnectingHealth } from './health.js';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const allocationProviderSchema = z.enum(['cloudflare', 'vercel', 'onprem']);

export const vercelAllocationConfigSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    snapshotId: z.string().min(1).optional(),
    runtimeBuildId: z.string().min(1).optional(),
    /**
     * BYOC credential build generation the demand bound, persisted so the
     * missing-snapshot projection is reconstructible after a DO eviction.
     */
    buildGeneration: z.string().min(1).optional(),
    runtime: z.string().min(1).optional(),
    resources: z
      .object({
        vcpus: z.number().int().positive(),
        memory: z.number().int().positive(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type VercelAllocationConfig = z.infer<typeof vercelAllocationConfigSchema>;

/**
 * On-prem allocation configuration pinned at demand time: the installation
 * binding, the resolved profile and the fixed-lifetime cap the allocation
 * cannot outlive, whichever it is driven to first. Provider-analogous to
 * `vercelAllocationConfigSchema`.
 */
export const onPremAllocationConfigSchema = z
  .object({
    binding: onPremProviderBindingSchema,
    profile: onPremProfileSchema,
    hardStopAt: timestamp,
  })
  .strict();

export type OnPremAllocationConfig = z.infer<typeof onPremAllocationConfigSchema>;

export const credentialContainmentSchema = z
  .object({
    kilocode: z.boolean(),
    github: z.boolean(),
    worktreeScoped: z.literal(true).optional(),
  })
  .strict();

export type CredentialContainmentRequirements = z.infer<typeof credentialContainmentSchema>;

export const WORKTREE_CREDENTIAL_CONTAINMENT = {
  kilocode: true,
  github: true,
  worktreeScoped: true,
} satisfies CredentialContainmentRequirements;

export function getWorktreeCredentialContainment(
  enabled: boolean
): CredentialContainmentRequirements {
  return enabled
    ? WORKTREE_CREDENTIAL_CONTAINMENT
    : { kilocode: false, github: false, worktreeScoped: true };
}

export const allocationContainmentSchema = credentialContainmentSchema.extend({
  providerRef: z.string().min(1),
});

export type AllocationContainment = z.infer<typeof allocationContainmentSchema>;

export const providerCapabilitiesSchema = z
  .object({
    persistentWorkspace: z.boolean(),
    destroysOnStop: z.boolean(),
  })
  .strict();

export type ProviderCapabilities = z.infer<typeof providerCapabilitiesSchema>;

/**
 * The exact target of a create effect, including the identity fields the lossy
 * legacy schema omitted. `resolvedContainment` is `PhysicalRecord.containment`
 * (the one carrying `providerRef`); `containment` is the create intent's
 * requirements.
 */
export const allocationTargetSchema = z
  .object({
    provider: allocationProviderSchema,
    providerRef: z.string().min(1).nullable(),
    allocationName: z.string().min(1).optional(),
    vercel: vercelAllocationConfigSchema.optional(),
    onprem: onPremAllocationConfigSchema.optional(),
    containment: credentialContainmentSchema.optional(),
    resolvedContainment: allocationContainmentSchema.optional(),
    capabilities: providerCapabilitiesSchema,
  })
  .strict();

export type AllocationTarget = z.infer<typeof allocationTargetSchema>;

export const allocationCreateIntentSchema = z
  .object({
    intentId: z.string().min(1),
    createdAt: timestamp,
  })
  .strict();

export type AllocationCreateIntent = z.infer<typeof allocationCreateIntentSchema>;

export const allocationStopIntentSchema = z
  .object({
    reason: z.string(),
    createdAt: timestamp,
    wrapperInstanceId: z.string().min(1).optional(),
    /** Allocation incarnation at stop time; retained to fence the destroy proof. */
    incarnation: z.string().min(1).optional(),
  })
  .strict();

export type AllocationStopIntent = z.infer<typeof allocationStopIntentSchema>;

export const stopProofSchema = z
  .object({
    effect: z.enum(['stop', 'destroy']),
    at: timestamp,
    providerRef: z.string().min(1).nullable(),
    allocationName: z.string().min(1).optional(),
    /** Incarnation the proof is fenced to; a stale proof is rejected. */
    incarnation: z.string().min(1),
    wrapper: z.string().min(1).optional(),
    reason: z.string().min(1),
  })
  .strict();

export type StopProof = z.infer<typeof stopProofSchema>;

export const allocationStoppedSummarySchema = z
  .object({
    providerRef: z.string().min(1).nullable(),
    allocationName: z.string().min(1).optional(),
    stopProof: stopProofSchema.optional(),
  })
  .strict();

export const stoppedAllocationStateSchema = z
  .object({
    kind: z.literal('stopped'),
    summary: allocationStoppedSummarySchema.nullable(),
  })
  .strict();

export const creatingAllocationStateSchema = z
  .object({
    kind: z.literal('creating'),
    requestId: z.string().min(1),
    target: allocationTargetSchema,
    createIntent: allocationCreateIntentSchema,
    attempt: z.number().int().nonnegative(),
    deadlineAt: timestamp,
  })
  .strict();

export const allocatedAllocationStateSchema = z
  .object({
    kind: z.literal('allocated'),
    target: allocationTargetSchema,
    createIntent: allocationCreateIntentSchema,
    health: healthStateSchema,
    /** Idle stop is armed once pinning work stops; never reset by a heartbeat. */
    idleAt: timestamp.nullable(),
  })
  .strict();

const stoppingBase = {
  kind: z.literal('stopping'),
  target: allocationTargetSchema,
  createIntent: allocationCreateIntentSchema,
  stopIntent: allocationStopIntentSchema,
  attempts: z.number().int().nonnegative(),
};

/** `destroying` always has its one absolute destroy deadline. */
export const stoppingDestroyingStateSchema = z
  .object({
    ...stoppingBase,
    step: z.literal('destroying'),
    deadlineAt: timestamp,
  })
  .strict();

/** `check_required` has no automatic timer, so it carries no deadline field. */
export const stoppingCheckRequiredStateSchema = z
  .object({
    ...stoppingBase,
    step: z.literal('check_required'),
  })
  .strict();

export const stoppingAllocationStateSchema = z.discriminatedUnion('step', [
  stoppingDestroyingStateSchema,
  stoppingCheckRequiredStateSchema,
]);

export const unknownAllocationStateSchema = z
  .object({
    kind: z.literal('unknown'),
    target: allocationTargetSchema.nullable(),
    createIntent: allocationCreateIntentSchema.nullable(),
    stopIntent: allocationStopIntentSchema.nullable(),
    /** Stop cleanup attempts already spent before existence became unknown. */
    attempts: z.number().int().nonnegative(),
    reason: z.string(),
    deadlineAt: timestamp,
  })
  .strict();

export const allocationStateSchema = z.union([
  stoppedAllocationStateSchema,
  creatingAllocationStateSchema,
  allocatedAllocationStateSchema,
  stoppingAllocationStateSchema,
  unknownAllocationStateSchema,
]);

export type AllocationState = z.infer<typeof allocationStateSchema>;
export type CreatingAllocation = z.infer<typeof creatingAllocationStateSchema>;
export type AllocatedAllocation = z.infer<typeof allocatedAllocationStateSchema>;
export type StoppingAllocation = z.infer<typeof stoppingAllocationStateSchema>;
export type StoppingDestroying = z.infer<typeof stoppingDestroyingStateSchema>;
export type StoppingCheckRequired = z.infer<typeof stoppingCheckRequiredStateSchema>;

export const allocationRecordSchema = z
  .object({
    v: z.literal(2),
    resumable: z.boolean(),
    state: allocationStateSchema,
  })
  .strict();

export type AllocationRecord = z.infer<typeof allocationRecordSchema>;

/** Stop-vs-destroy policy (plan §4): persistent providers are never destroyed. */
export function allocationEffect(capabilities: ProviderCapabilities): 'stop' | 'destroy' {
  return capabilities.persistentWorkspace || !capabilities.destroysOnStop ? 'stop' : 'destroy';
}

export function initialAllocationRecord(resumable: boolean): AllocationRecord {
  return { v: 2, resumable, state: { kind: 'stopped', summary: null } };
}

/**
 * Allocated health is built by the health owner; this only installs the state it
 * returns alongside the allocation's own target/intent/idle anchor.
 */
export function allocatedConnecting(
  target: AllocationTarget,
  createIntent: AllocationCreateIntent,
  health: ConnectingHealth,
  idleAt: number | null = null
): AllocatedAllocation {
  return { kind: 'allocated', target, createIntent, health, idleAt };
}
