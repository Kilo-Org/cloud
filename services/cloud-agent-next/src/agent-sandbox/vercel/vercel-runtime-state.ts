import * as z from 'zod';

import type { SandboxId } from '../../types.js';

/**
 * Durable-storage keys for Vercel runtime state owned by the session DO.
 * The key names are persisted in live sessions and must stay stable.
 */
export const VERCEL_CREATE_INTENT_KEY = 'vercel_create_intent';
export const VERCEL_WRAPPER_LAUNCH_INTENT_KEY = 'vercel_wrapper_launch_intent';
export const VERCEL_DELETION_TOMBSTONE_KEY = 'vercel_deletion_tombstone';

export const VERCEL_CREATE_SETTLE_MS = 5 * 60 * 1000;
export const VERCEL_CREATE_RETRY_DELAY_MS = 10 * 1000;
export const VERCEL_STOP_ATTEMPT_TIMEOUT_MS = 30 * 1000;

const SandboxIdSchema = z
  .string()
  .regex(/^ses-[0-9a-f]+$/)
  .transform(value => value as SandboxId);
const VercelSandboxRuntimeSchema = z.enum(['node22', 'node24', 'node26', 'python3.13']);

export const VercelCreateIntentSchema = z
  .object({
    version: z.literal(1),
    sandboxName: SandboxIdSchema,
    operationId: z.string().min(1),
    projectId: z.string().min(1),
    snapshotId: z.string().min(1),
    runtimeBuildId: z.string().min(1),
    runtime: VercelSandboxRuntimeSchema,
    startedAt: z.number().nonnegative(),
    settleUntil: z.number().nonnegative(),
    attempts: z.number().int().nonnegative(),
    nextRetryAt: z.number().nonnegative(),
  })
  .strict();

export const VercelWrapperLaunchIntentSchema = z
  .object({
    sessionId: z.string().min(1),
    launchId: z.string().min(1),
    instanceId: z.string().min(1),
    instanceGeneration: z.number().int().nonnegative(),
    startedAt: z.number().nonnegative(),
  })
  .strict();

const VercelUnresolvedCreateSchema = z
  .object({
    operationId: z.string().min(1),
    projectId: z.string().min(1),
    snapshotId: z.string().min(1),
    runtimeBuildId: z.string().min(1),
    runtime: VercelSandboxRuntimeSchema,
    settleUntil: z.number().nonnegative(),
  })
  .strict();

const VercelStopStateSchema = z.discriminatedUnion('status', [
  z
    .object({
      status: z.literal('needed'),
      attempts: z.number().int().nonnegative(),
      nextAttemptAt: z.number().nonnegative(),
    })
    .strict(),
  z
    .object({
      status: z.literal('stopping'),
      attempts: z.number().int().positive(),
      nextAttemptAt: z.number().nonnegative(),
      attemptId: z.string().min(1),
      attemptDeadlineAt: z.number().nonnegative(),
    })
    .strict(),
]);

export const VercelStopTombstoneSchema = z
  .object({
    version: z.literal(2),
    provider: z.literal('vercel'),
    sandboxName: SandboxIdSchema,
    sessionId: z.string().min(1).optional(),
    unresolvedCreate: VercelUnresolvedCreateSchema.optional(),
    intent: z
      .object({
        reason: z.enum(['explicit', 'retention-expired']),
        startedAt: z.number().nonnegative(),
      })
      .strict(),
    stop: VercelStopStateSchema,
  })
  .strict()
  .refine(value => value.sessionId !== undefined || value.unresolvedCreate !== undefined, {
    message: 'Vercel stop tombstone requires an exact session or unresolved create',
  });

const LegacyVercelStopTombstoneSchema = z.object({
  version: z.literal(1),
  provider: z.literal('vercel'),
});

export type VercelCreateIntent = z.infer<typeof VercelCreateIntentSchema>;
export type VercelWrapperLaunchIntent = z.infer<typeof VercelWrapperLaunchIntentSchema>;
export type VercelStopTombstone = z.infer<typeof VercelStopTombstoneSchema>;

export function parseVercelCreateIntent(value: unknown): VercelCreateIntent {
  return VercelCreateIntentSchema.parse(value);
}

export function parseVercelWrapperLaunchIntent(value: unknown): VercelWrapperLaunchIntent {
  return VercelWrapperLaunchIntentSchema.parse(value);
}

export function parseVercelStopTombstone(
  value: unknown
): VercelStopTombstone | { status: 'manual-remediation'; version: 1 } {
  const version = z.object({ version: z.number() }).passthrough().parse(value).version;
  if (version === 1) {
    LegacyVercelStopTombstoneSchema.passthrough().parse(value);
    return { status: 'manual-remediation', version: 1 };
  }
  return VercelStopTombstoneSchema.parse(value);
}

export function claimVercelStopAttempt(
  tombstone: VercelStopTombstone,
  attemptId: string,
  now: number,
  attemptDeadlineAt: number
): VercelStopTombstone | null {
  const due =
    (tombstone.stop.status === 'needed' && tombstone.stop.nextAttemptAt <= now) ||
    (tombstone.stop.status === 'stopping' && tombstone.stop.attemptDeadlineAt <= now);
  if (!due || attemptDeadlineAt <= now) return null;

  return {
    ...tombstone,
    stop: {
      status: 'stopping',
      attempts: tombstone.stop.attempts + 1,
      nextAttemptAt: tombstone.stop.nextAttemptAt,
      attemptId,
      attemptDeadlineAt,
    },
  };
}

export function retryVercelStopAttempt(
  tombstone: VercelStopTombstone,
  attemptId: string,
  nextAttemptAt: number
): VercelStopTombstone | null {
  if (tombstone.stop.status !== 'stopping' || tombstone.stop.attemptId !== attemptId) return null;
  return {
    ...tombstone,
    stop: {
      status: 'needed',
      attempts: tombstone.stop.attempts,
      nextAttemptAt,
    },
  };
}

type VercelSessionStatus =
  | 'failed'
  | 'aborted'
  | 'pending'
  | 'stopping'
  | 'snapshotting'
  | 'running'
  | 'stopped'
  | 'not-found';

export function classifyVercelSession(
  status: VercelSessionStatus,
  policy: { notFoundIsTerminal: boolean } = { notFoundIsTerminal: false }
): 'active' | 'terminal' | 'unknown' {
  if (status === 'stopped' || status === 'aborted' || status === 'failed') return 'terminal';
  if (status === 'not-found') return policy.notFoundIsTerminal ? 'terminal' : 'unknown';
  return 'active';
}
