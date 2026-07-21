import { z } from 'zod';
import { recordStartFailureCodeSchema } from '@kilocode/container-usage';

export const failoverMutationSchema = z
  .object({
    operation: z.enum(['start', 'heartbeat', 'stop']),
    intervalId: z.string().min(1),
    idempotencyKey: z.string().min(1),
    contextFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    payload: z.record(z.string(), z.unknown()),
    receivedAtMs: z.number().int().nonnegative(),
  })
  .strict();
export type FailoverMutation = z.infer<typeof failoverMutationSchema>;

export type FailoverEnqueueResult =
  | { dedup: false; conflict: true }
  | { dedup: boolean; conflict?: false };
export type FailoverBacklog = { count: number; oldestReceivedAtMs?: number };
export type FailoverMutationStatus = 'absent' | 'match' | 'conflict';
export const startAdmissionSchema = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true) }).strict(),
  z
    .object({
      accepted: z.literal(false),
      code: recordStartFailureCodeSchema,
      message: z.string().min(1),
    })
    .strict(),
]);
export type StartAdmission = z.infer<typeof startAdmissionSchema>;
export type DurableStartAdmissionResult =
  | { status: 'pending' }
  | { status: 'accepted'; dedup: boolean }
  | {
      status: 'rejected';
      code: z.infer<typeof recordStartFailureCodeSchema>;
      message: string;
    }
  | { status: 'conflict' };
export type ExistingStartAdmissionResult = DurableStartAdmissionResult | { status: 'absent' };
export type AdmittedMutationResult =
  | { status: 'accepted'; dedup: boolean }
  | { status: 'not_admitted' }
  | { status: 'conflict' };

function canonicalizeJson(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Failover payload numbers must be finite');
    return value;
  }
  if (Array.isArray(value)) return value.map(canonicalizeJson);
  if (typeof value !== 'object') {
    throw new Error('Failover payload must contain only JSON values');
  }

  const result: Record<string, unknown> = {};
  for (const key of Object.keys(value).sort()) {
    const entry = (value as Record<string, unknown>)[key];
    if (entry !== undefined) result[key] = canonicalizeJson(entry);
  }
  return result;
}

export function serializeFailoverPayload(payload: Record<string, unknown>): string {
  return JSON.stringify(canonicalizeJson(payload));
}
