import { z } from 'zod';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import {
  AWS_EC2_TAGS,
  awsEc2ByocConfigurationSchema,
  awsEc2SnapshotIdSchema,
  awsEc2VolumeIdSchema,
} from '@kilocode/worker-utils/aws-ec2';
import type { AwsEc2Client, AwsEc2Snapshot } from '@kilocode/worker-utils/aws-ec2-client';
import type { SnapshotCaptureResult } from './snapshots.js';

const CAPTURE_SETTLE_MS = 5 * 60_000;

const sourceSchema = z.object({
  config: awsEc2ByocConfigurationSchema,
  generation: z.uuid(),
  volumeId: awsEc2VolumeIdSchema,
  baseImage: z.string().min(1),
});
export type AwsEc2SnapshotSource = z.infer<typeof sourceSchema>;

export const awsEc2SnapshotOperationSchema = z.object({
  source: sourceSchema,
  requestedAt: z.number().int().nonnegative(),
  snapshotId: awsEc2SnapshotIdSchema.optional(),
});
export type AwsEc2SnapshotOperation = z.infer<typeof awsEc2SnapshotOperationSchema>;

export type AwsEc2SnapshotStorage = {
  get(captureId: string): Promise<unknown>;
  /** The owning DO must read and write in a single storage transaction. */
  update(captureId: string, update: (current: unknown) => AwsEc2SnapshotOperation): Promise<void>;
  delete(captureId: string): Promise<void>;
};

type SnapshotClient = Pick<AwsEc2Client, 'createSnapshot' | 'findSnapshot' | 'deleteSnapshot'>;

/** AWS supplies no CreateSnapshot idempotency token. Poll the capture tag after an uncertain call. */
export function createAwsEc2SnapshotCapture(deps: {
  storage: AwsEc2SnapshotStorage;
  client(config: AwsEc2SnapshotSource['config']): Promise<SnapshotClient>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  async function read(captureId: string) {
    return awsEc2SnapshotOperationSchema
      .optional()
      .parse(await deps.storage.get(z.uuid().parse(captureId)));
  }
  async function accepted(captureId: string, snapshotId: string) {
    await deps.storage.update(captureId, raw => {
      const operation = awsEc2SnapshotOperationSchema.parse(raw);
      if (operation.snapshotId && operation.snapshotId !== snapshotId)
        throw new AwsRequestError(422, 'Ec2SnapshotIdentityMismatch');
      return { ...operation, snapshotId };
    });
  }
  async function find(captureId: string, operation: AwsEc2SnapshotOperation) {
    const ec2 = await deps.client(operation.source.config);
    const found = await ec2.findSnapshot(
      operation.source.config,
      operation.snapshotId ? { id: operation.snapshotId } : { captureId }
    );
    if (
      found &&
      (found.volumeId !== operation.source.volumeId ||
        found.tags.get(AWS_EC2_TAGS.generation) !== operation.source.generation ||
        found.tags.get(AWS_EC2_TAGS.capture) !== captureId)
    )
      throw new AwsRequestError(422, 'Ec2SnapshotIdentityMismatch');
    return { ec2, found };
  }
  function result(
    operation: AwsEc2SnapshotOperation,
    found: AwsEc2Snapshot
  ): SnapshotCaptureResult {
    if (found.state === 'error' || found.state === 'recoverable')
      return { status: 'failed', reason: 'snapshot_failed' };
    if (found.state !== 'completed') return { status: 'in_progress' };
    if (found.encrypted !== true) return { status: 'failed', reason: 'snapshot_failed' };
    return {
      status: 'stored',
      snapshotId: found.id,
      capturedAt: operation.requestedAt,
      durationMs: now() - operation.requestedAt,
      baseImage: operation.source.baseImage,
    };
  }
  return {
    /** Call while holding the source stopped. `accepted` durably records AWS's point-in-time capture. */
    async start(
      captureId: string,
      source: AwsEc2SnapshotSource
    ): Promise<'accepted' | 'uncertain'> {
      z.uuid().parse(captureId);
      const checked = sourceSchema.parse(source);
      const operation = { source: checked, requestedAt: now() };
      // Resolve credentials before claiming the one non-idempotent request.
      const ec2 = await deps.client(checked.config);
      let reserved = false;
      await deps.storage.update(captureId, raw => {
        const previous = awsEc2SnapshotOperationSchema.optional().parse(raw);
        reserved = previous === undefined;
        if (!previous) return operation;
        if (JSON.stringify(previous.source) !== JSON.stringify(checked))
          throw new AwsRequestError(422, 'Ec2SnapshotIdentityMismatch');
        return previous;
      });
      if (!reserved) {
        const current = await read(captureId);
        if (!current) throw new AwsRequestError(422, 'Ec2SnapshotIdentityMismatch');
        if (current.snapshotId) return 'accepted';
        const { found } = await find(captureId, current);
        if (!found) return 'uncertain';
        await accepted(captureId, found.id);
        return 'accepted';
      }
      try {
        const snapshot = await ec2.createSnapshot(
          checked.config,
          checked.volumeId,
          checked.generation,
          captureId
        );
        await accepted(captureId, snapshot.id);
        return 'accepted';
      } catch (error) {
        if (!(error instanceof AwsRequestError) || error.status === 0 || error.status >= 500)
          return 'uncertain';
        throw error;
      }
    },
    async poll(captureId: string): Promise<SnapshotCaptureResult> {
      const operation = await read(captureId);
      if (!operation) return { status: 'failed', reason: 'abandoned' };
      const { found } = await find(captureId, operation);
      if (found) {
        if (!operation.snapshotId) await accepted(captureId, found.id);
        return result(operation, found);
      }
      return now() - operation.requestedAt >= CAPTURE_SETTLE_MS
        ? { status: 'failed', reason: 'uncertain' }
        : { status: 'in_progress' };
    },
    async discard(captureId: string): Promise<'done' | 'pending'> {
      const operation = await read(captureId);
      if (!operation) return 'done';
      const { ec2, found } = await find(captureId, operation);
      if (!found) {
        if (now() - operation.requestedAt < CAPTURE_SETTLE_MS) return 'pending';
        await deps.storage.delete(captureId);
        return 'done';
      }
      if (found.state === 'pending' || found.state === 'recovering') return 'pending';
      await ec2.deleteSnapshot(found.id);
      return 'pending';
    },
  };
}
