import { z } from 'zod';
import {
  sessionSnapshotCaptureInputSchema,
  sessionSnapshotDescriptorSchema,
  sessionSnapshotIdentitySchema,
} from '../session-snapshot.js';

export const SESSION_SNAPSHOT_ALLOCATION_KEY = 'session_disk_allocation:v1';
export const SESSION_SNAPSHOT_FENCE_KEY = 'session_disk_capture_fence:v1';
export const SESSION_SNAPSHOT_REVOKED_KEY = 'session_disk_capture_revoked:v1';
export const sessionSnapshotRevocationSchema = z
  .object({
    captureId: z.uuid(),
    allocationId: z.string().min(1),
    deadlineAt: z.number().int().nonnegative(),
  })
  .strict();

export function sessionSnapshotRevoked(
  storage: DurableObjectStorage['kv'],
  captureId: string
): boolean {
  const value = storage.get(SESSION_SNAPSHOT_REVOKED_KEY);
  if (value === undefined) return false;
  const parsed = sessionSnapshotRevocationSchema.safeParse(value);
  return !parsed.success || parsed.data.captureId === captureId;
}

export const sessionSnapshotAllocationSchema = z
  .object({
    allocationId: z.string().min(1),
    runtimeIdentity: z.string().min(1),
    sessions: z.array(z.string().min(1)),
    owner: sessionSnapshotIdentitySchema.optional(),
    activity: z
      .object({ connectionId: z.string().min(1), active: z.boolean() })
      .strict()
      .optional(),
    restore: z
      .object({
        state: z.enum(['pending', 'restored', 'fresh', 'failed']),
        descriptor: sessionSnapshotDescriptorSchema,
      })
      .strict()
      .optional(),
  })
  .strict();

export const sessionSnapshotFenceSchema = z
  .object({
    input: sessionSnapshotCaptureInputSchema,
    allocationId: z.string().min(1),
    connectionId: z.string().min(1),
    providerRef: z.string().min(1),
    attemptId: z.string().min(1),
    runtimeIdentity: z.string().min(1),
    deadlineAt: z.number().int().nonnegative(),
  })
  .strict();

export function readSessionSnapshotAllocation(storage: DurableObjectStorage['kv']) {
  const parsed = sessionSnapshotAllocationSchema.safeParse(
    storage.get(SESSION_SNAPSHOT_ALLOCATION_KEY)
  );
  return parsed.success ? parsed.data : undefined;
}
