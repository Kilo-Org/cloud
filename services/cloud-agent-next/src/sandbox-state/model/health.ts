/**
 * Runtime-health machine (design §6). Nested inside `allocated` and scoped to one
 * allocation incarnation. The canonical schema is the stored shape.
 *
 * Evidence is fenced by incarnation: the canonical schemas reject a health state
 * whose evidence belongs to a different incarnation, and the reducer drops a
 * mismatched event rather than treating it as evidence.
 */
import { z } from 'zod';

export const healthIncarnationSchema = z.string().min(1).max(256);

export const heartbeatSchema = z
  .object({
    incarnation: healthIncarnationSchema,
    at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    ready: z.boolean(),
  })
  .strict();

export type HeartbeatEvidence = z.infer<typeof heartbeatSchema>;

export const observationSchema = z
  .object({
    incarnation: healthIncarnationSchema,
    at: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    providerState: z.enum(['active', 'terminal', 'unknown']),
  })
  .strict();

export type ProviderObservation = z.infer<typeof observationSchema>;

export const healthRecoveryStepSchema = z.enum(['check_sandbox', 'reconnect_wrapper']);
export type HealthRecoveryStep = z.infer<typeof healthRecoveryStepSchema>;

/** Why recovery was entered; derived purely by the reducer from the entering event. */
export const recoveryCauseSchema = z.enum([
  'activation_pending',
  'control_disconnected',
  'heartbeat_expired',
]);
export type RecoveryCause = z.infer<typeof recoveryCauseSchema>;

export const healthVerdictSchema = z.enum(['absent', 'unresponsive']);
export type HealthVerdict = z.infer<typeof healthVerdictSchema>;

export const connectingHealthSchema = z
  .object({
    kind: z.literal('connecting'),
    incarnation: healthIncarnationSchema,
    deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    lastObservation: observationSchema.optional(),
  })
  .strict()
  .refine(
    value =>
      value.lastObservation === undefined ||
      value.lastObservation.incarnation === value.incarnation,
    { message: 'connecting observation must match the health incarnation' }
  );

export const healthyHealthSchema = z
  .object({
    kind: z.literal('healthy'),
    incarnation: healthIncarnationSchema,
    lastHeartbeat: heartbeatSchema,
    lastObservation: observationSchema.optional(),
    deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  })
  .strict()
  .refine(value => value.lastHeartbeat.incarnation === value.incarnation, {
    message: 'healthy heartbeat must match the health incarnation',
  })
  .refine(
    value =>
      value.lastObservation === undefined ||
      value.lastObservation.incarnation === value.incarnation,
    { message: 'healthy observation must match the health incarnation' }
  );

export const recoveringHealthSchema = z
  .object({
    kind: z.literal('recovering'),
    incarnation: healthIncarnationSchema,
    step: healthRecoveryStepSchema,
    attempts: z.number().int().nonnegative(),
    deadlineAt: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
    /** Episode identity: minted once at the impure dispatch boundary, stable across attempts. */
    episodeId: z.string().uuid(),
    cause: recoveryCauseSchema,
    /** Live wrapper identity the recovery attempt must reconcile against, when known. */
    expectedWrapperInstanceId: z.string().min(1).optional(),
  })
  .strict();

export const unhealthyHealthSchema = z
  .object({
    kind: z.literal('unhealthy'),
    incarnation: healthIncarnationSchema,
    verdict: healthVerdictSchema,
  })
  .strict();

export const healthStateSchema = z.union([
  connectingHealthSchema,
  healthyHealthSchema,
  recoveringHealthSchema,
  unhealthyHealthSchema,
]);

export type HealthState = z.infer<typeof healthStateSchema>;
export type ConnectingHealth = z.infer<typeof connectingHealthSchema>;
export type HealthyHealth = z.infer<typeof healthyHealthSchema>;
export type RecoveringHealth = z.infer<typeof recoveringHealthSchema>;
export type UnhealthyHealth = z.infer<typeof unhealthyHealthSchema>;

/**
 * Health-owned constructors. The allocation counter must not build health states
 * inline, so the incarnation/deadline pairing stays in one place.
 */
export function connectingHealth(incarnation: string, deadlineAt: number): ConnectingHealth {
  return { kind: 'connecting', incarnation, deadlineAt };
}
