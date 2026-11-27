import { z } from 'zod';
import { LOGIN_NAMES, ROTATION_POOLS } from './config';
import { SealedSchema } from './vault';

const PoolSchema = z.enum(ROTATION_POOLS);
const LoginSchema = z.enum(LOGIN_NAMES);
const TimeSchema = z.number().int().nonnegative();
const SecretNameSchema = z.string().regex(/^[a-z][a-z0-9_]{0,62}_[0-9]{8}_[0-9]{6}$/);

/** The login one cycle rotates, in the pool whose config it then switches to. */
const CycleFields = { pool: PoolSchema, login: LoginSchema, startedAt: TimeSchema };

/**
 * The one phase of the rotation job (design 5.2). Only one cycle is open at a time, so a second
 * rotation never starts while an approval or a switch is open.
 */
export const JobStateSchema = z.discriminatedUnion('phase', [
  /** No cycle open; nothing runs before `nextAttemptAt`. */
  z.strictObject({ phase: z.literal('idle'), nextAttemptAt: TimeSchema }),
  /** A new password is chosen and kept sealed; the `ALTER` has not been confirmed. */
  z.strictObject({
    phase: z.literal('altering'),
    ...CycleFields,
    pending: SealedSchema,
    nextAttemptAt: TimeSchema,
  }),
  /** The login has its new password; the manager has not yet accepted the secret. */
  z.strictObject({
    phase: z.literal('storing'),
    ...CycleFields,
    secretName: SecretNameSchema,
    nextAttemptAt: TimeSchema,
  }),
  /**
   * The manager holds the secret as a change request that waits for a secret admin. `lastAlertAt`
   * is the last overdue alert, at most one a day; null before the first.
   */
  z.strictObject({
    phase: z.literal('awaiting_approval'),
    ...CycleFields,
    secretName: SecretNameSchema,
    requestedAt: TimeSchema,
    nextCheckAt: TimeSchema,
    lastAlertAt: TimeSchema.nullable(),
  }),
  /** The secret exists in the manager; the config switch waits for its window or a retry. */
  z.strictObject({
    phase: z.literal('switching'),
    ...CycleFields,
    secretName: SecretNameSchema,
    nextAttemptAt: TimeSchema,
  }),
  /**
   * Neither the pending nor the current password logs in. The job checks the seed secret each
   * `nextCheckAt`; a secret admin restores the login there after a break-glass read.
   */
  z.strictObject({
    phase: z.literal('lost'),
    ...CycleFields,
    pending: SealedSchema,
    since: TimeSchema,
    nextCheckAt: TimeSchema,
  }),
]);
export type JobState = z.infer<typeof JobStateSchema>;

export const RotationStateSchema = z.strictObject({
  /** Each login's current password, sealed; a login without one waits for its seed. */
  logins: z.partialRecord(LoginSchema, SealedSchema),
  /** The time each pool's config last switched logins. */
  switchedAt: z.partialRecord(PoolSchema, TimeSchema),
  job: JobStateSchema,
});
export type RotationState = z.infer<typeof RotationStateSchema>;

/** The stored state and the revision a commit must still find to replace it. */
export const StoredRotationSchema = z.strictObject({
  revision: z.number().int().nonnegative(),
  state: RotationStateSchema,
});
export type StoredRotation = z.infer<typeof StoredRotationSchema>;

export const INITIAL_ROTATION: StoredRotation = {
  revision: 0,
  state: { logins: {}, switchedAt: {}, job: { phase: 'idle', nextAttemptAt: 0 } },
};
