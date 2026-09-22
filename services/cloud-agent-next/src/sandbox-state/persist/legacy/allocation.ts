/**
 * Frozen decoder for today's flat allocation record (design §9; plan §3).
 *
 * This module is imported only by `persist/load.ts` (enforced by the quarantine
 * compliance test). It freezes the production `PhysicalRecord` shape instead of
 * importing it, because the legacy modules are deleted in a later chunk. The
 * converter preserves every field the lossy `durable-state.ts` schema omits:
 * `createIntent.allocationName`, `createIntent.vercel`, `createIntent.containment`,
 * `record.containment` (with `providerRef`) and `stopTombstone.wrapperInstanceId`.
 */
import { z } from 'zod';
import type {
  AllocationRecord,
  AllocationState,
  AllocationTarget,
  ProviderCapabilities,
} from '../../model/allocation.js';
import { POLICY } from '../../schedule.js';

const timestamp = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);

export const legacyCredentialContainmentSchema = z
  .object({
    kilocode: z.boolean(),
    github: z.boolean(),
    worktreeScoped: z.literal(true).optional(),
  })
  .strict();

export const legacyAllocationContainmentSchema = legacyCredentialContainmentSchema.extend({
  providerRef: z.string().min(1),
});

export const legacyVercelConfigSchema = z
  .object({
    projectId: z.string().min(1).optional(),
    snapshotId: z.string().min(1).optional(),
    runtimeBuildId: z.string().min(1).optional(),
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

export const legacyCreateIntentSchema = z
  .object({
    intentId: z.string().min(1),
    createdAt: timestamp,
    allocationName: z.string().min(1).optional(),
    vercel: legacyVercelConfigSchema.optional(),
    containment: legacyCredentialContainmentSchema.optional(),
  })
  .strict();

export const legacyStopTombstoneSchema = z
  .object({
    reason: z.string(),
    attempts: z.number().int().nonnegative(),
    createdAt: timestamp,
    wrapperInstanceId: z.string().min(1).optional(),
  })
  .strict();

export const legacyAllocationSchema = z
  .object({
    state: z.enum(['stopped', 'creating', 'running', 'stopping', 'failed', 'unknown']),
    providerRef: z.string().min(1).nullable(),
    createIntent: legacyCreateIntentSchema.nullable(),
    stopTombstone: legacyStopTombstoneSchema.nullable(),
    resumable: z.boolean(),
    containment: legacyAllocationContainmentSchema.optional(),
    /** Foreign residue used a top-level version; only the free `2` is tolerated. */
    version: z.literal(2).optional(),
  })
  .strict();

export type LegacyAllocation = z.infer<typeof legacyAllocationSchema>;

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

/** Foreign sibling residue owns a `v` marker (including `v: undefined`). */
export function isForeignMarker(value: unknown): boolean {
  return typeof value === 'object' && value !== null && hasOwn(value, 'v');
}

function capabilitiesFor(vercel: boolean): ProviderCapabilities {
  return vercel
    ? { persistentWorkspace: true, destroysOnStop: false }
    : { persistentWorkspace: false, destroysOnStop: true };
}

function targetFor(record: LegacyAllocation): AllocationTarget {
  const createIntent = record.createIntent;
  const vercel = createIntent?.vercel;
  const target: AllocationTarget = {
    provider: vercel ? 'vercel' : 'cloudflare',
    providerRef: record.providerRef,
    capabilities: capabilitiesFor(vercel !== undefined),
  };
  if (createIntent?.allocationName !== undefined)
    target.allocationName = createIntent.allocationName;
  if (vercel !== undefined) target.vercel = vercel;
  if (createIntent?.containment !== undefined) target.containment = createIntent.containment;
  if (record.containment !== undefined) target.resolvedContainment = record.containment;
  return target;
}

function createIntent(record: LegacyAllocation) {
  const intent = record.createIntent;
  if (!intent) return null;
  return { intentId: intent.intentId, createdAt: intent.createdAt };
}

function stoppedState(record: LegacyAllocation): AllocationState {
  const createIntentValue = record.createIntent;
  if (!record.providerRef && !createIntentValue) {
    return { kind: 'stopped', summary: null };
  }
  return {
    kind: 'stopped',
    summary: {
      providerRef: record.providerRef,
      ...(createIntentValue?.allocationName !== undefined
        ? { allocationName: createIntentValue.allocationName }
        : {}),
    },
  };
}

/**
 * Converts a validated legacy record. Returns `undefined` when the record cannot
 * be represented (for example `running` without a create intent), which the
 * loader turns into a fail-closed result.
 */
export function convertLegacyAllocation(record: LegacyAllocation): AllocationRecord | undefined {
  const target = targetFor(record);
  const intent = createIntent(record);

  switch (record.state) {
    case 'stopped':
      return { v: 2, resumable: record.resumable, state: stoppedState(record) };
    case 'creating': {
      if (!intent) return undefined;
      return {
        v: 2,
        resumable: record.resumable,
        state: {
          kind: 'creating',
          requestId: intent.intentId,
          target,
          createIntent: intent,
          attempt: 0,
          deadlineAt: intent.createdAt + POLICY.createDeadlineMs,
        },
      };
    }
    case 'running': {
      if (!intent) return undefined;
      return {
        v: 2,
        resumable: record.resumable,
        state: {
          kind: 'allocated',
          target,
          createIntent: intent,
          health: {
            kind: 'connecting',
            incarnation: intent.intentId,
            deadlineAt: intent.createdAt + POLICY.connectingDeadlineMs,
          },
          idleAt: null,
        },
      };
    }
    case 'stopping': {
      if (!intent) return undefined;
      const tombstone = record.stopTombstone;
      const reason = tombstone?.reason ?? 'legacy_stopping';
      const attempts = tombstone?.attempts ?? 0;
      const createdAt = tombstone?.createdAt ?? intent.createdAt;
      return {
        v: 2,
        resumable: record.resumable,
        state: {
          kind: 'stopping',
          target,
          createIntent: intent,
          stopIntent: {
            reason,
            createdAt,
            ...(tombstone?.wrapperInstanceId !== undefined
              ? { wrapperInstanceId: tombstone.wrapperInstanceId }
              : {}),
          },
          step: 'destroying',
          attempts,
          deadlineAt: createdAt + POLICY.stopDeadlineMs,
        },
      };
    }
    case 'failed':
    case 'unknown': {
      const from = intent?.createdAt ?? record.stopTombstone?.createdAt ?? 0;
      return {
        v: 2,
        resumable: record.resumable,
        state: {
          kind: 'unknown',
          target,
          createIntent: intent,
          stopIntent: record.stopTombstone
            ? {
                reason: record.stopTombstone.reason,
                createdAt: record.stopTombstone.createdAt,
                ...(record.stopTombstone.wrapperInstanceId !== undefined
                  ? { wrapperInstanceId: record.stopTombstone.wrapperInstanceId }
                  : {}),
              }
            : null,
          attempts: record.stopTombstone?.attempts ?? 0,
          reason: record.state === 'failed' ? 'legacy_failed' : 'legacy_unknown',
          deadlineAt: from + POLICY.observeDeadlineMs,
        },
      };
    }
  }
}

/** Frozen legacy decode. Returns `undefined` on a foreign marker or malformed shape. */
export function decodeLegacyAllocation(value: unknown): AllocationRecord | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  if (isForeignMarker(value)) return undefined;
  const parsed = legacyAllocationSchema.safeParse(value);
  if (!parsed.success) return undefined;
  return convertLegacyAllocation(parsed.data);
}
