import { z } from 'zod';

export const SNAPSHOT_START_FAILURES_KEY = 'containers:snapshot-start-failures:v1';
export const MAX_SNAPSHOT_START_FAILURES = 3;
const MAX_FAILED_SNAPSHOTS = 16;
const schema = z
  .array(z.object({ snapshotId: z.string(), failures: z.number().int().nonnegative() }))
  .max(MAX_FAILED_SNAPSHOTS);
export type SnapshotStartFailures = z.infer<typeof schema>;

export function parseSnapshotStartFailures(value: unknown): SnapshotStartFailures {
  const result = schema.safeParse(value);
  return result.success ? result.data : [];
}

export function recordSnapshotStartFailure(
  records: SnapshotStartFailures,
  snapshotId: string
): SnapshotStartFailures {
  const failures = records.find(record => record.snapshotId === snapshotId)?.failures ?? 0;
  return [
    { snapshotId, failures: Math.min(MAX_SNAPSHOT_START_FAILURES, failures + 1) },
    ...records.filter(record => record.snapshotId !== snapshotId),
  ].slice(0, MAX_FAILED_SNAPSHOTS);
}
