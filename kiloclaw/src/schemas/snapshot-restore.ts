import { z } from 'zod';

/**
 * Queue message body for snapshot restore jobs.
 * Sent by the DO's enqueueSnapshotRestore() method, consumed by the queue worker.
 */
export const SnapshotRestoreMessageSchema = z.object({
  userId: z.string(),
  snapshotId: z.string(),
  previousVolumeId: z.string(),
  region: z.string(),
});

export type SnapshotRestoreMessage = z.infer<typeof SnapshotRestoreMessageSchema>;
