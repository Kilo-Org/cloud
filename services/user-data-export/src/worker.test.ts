import { describe, expect, it, vi } from 'vitest';
import {
  consumeDeadLetterBatch,
  deletePendingObjects,
  exportHeader,
  type ExportEnv,
} from './worker';
import type { ExportJob } from './databases';

function queueMessage(body: unknown) {
  return {
    body,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

describe('dead-letter queue consumption', () => {
  it('generation-fences terminal failure and acknowledges the message', async () => {
    const message = queueMessage({
      version: 1,
      operation: 'generate',
      exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
      generation: 3,
    });
    const state = { markFailed: vi.fn() };

    await consumeDeadLetterBatch({ messages: [message] }, {} as ExportEnv, state);

    expect(state.markFailed).toHaveBeenCalledWith('f6ba5ce5-9061-4f7f-9ec6-76f047573f1c', 3);
    expect(message.ack).toHaveBeenCalledOnce();
  });

  it('acknowledges malformed dead-letter payloads without mutating state', async () => {
    const message = queueMessage({ prompt: 'must not be present' });
    const state = { markFailed: vi.fn() };

    await consumeDeadLetterBatch({ messages: [message] }, {} as ExportEnv, state);

    expect(state.markFailed).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
  });
});

describe('export header timestamps', () => {
  it('normalizes PostgreSQL timestamps and keeps request time distinct from cutoff', () => {
    const header = JSON.parse(
      exportHeader({
        id: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        kilo_user_id: 'user-id',
        status: 'processing',
        snapshot_at: '2026-08-03 00:00:00+00',
        requested_at: '2026-08-09 05:00:00.123+00',
        current_source: 'app_builder_projects',
        source_cursor: null,
        multipart_upload_id: null,
        next_part_number: 1,
        dispatch_generation: 0,
        lease_token: null,
        r2_object_key: null,
      } satisfies ExportJob).trim()
    ) as { requestedAt: string; snapshotAt: string };

    expect(header.requestedAt).toBe('2026-08-09T05:00:00.123Z');
    expect(header.snapshotAt).toBe('2026-08-03T00:00:00.000Z');
  });
});

describe('account-deletion object cleanup', () => {
  it('removes a tombstone only after R2 deletion succeeds', async () => {
    const state = {
      pendingObjectDeletions: vi
        .fn()
        .mockResolvedValue([{ object_key: 'exports/id/file.gz', multipart_upload_id: null }]),
      completeObjectDeletion: vi.fn(),
      recordObjectDeletionFailure: vi.fn(),
    };
    const bucket = { delete: vi.fn(), resumeMultipartUpload: vi.fn() };

    await deletePendingObjects(bucket, state);

    expect(bucket.delete).toHaveBeenCalledWith('exports/id/file.gz');
    expect(state.completeObjectDeletion).toHaveBeenCalledWith('exports/id/file.gz');
    expect(state.recordObjectDeletionFailure).not.toHaveBeenCalled();
  });

  it('retains the tombstone and records a failed R2 deletion attempt', async () => {
    const state = {
      pendingObjectDeletions: vi
        .fn()
        .mockResolvedValue([{ object_key: 'exports/id/file.gz', multipart_upload_id: null }]),
      completeObjectDeletion: vi.fn(),
      recordObjectDeletionFailure: vi.fn(),
    };
    const bucket = {
      delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
      resumeMultipartUpload: vi.fn(),
    };

    await deletePendingObjects(bucket, state);

    expect(state.completeObjectDeletion).not.toHaveBeenCalled();
    expect(state.recordObjectDeletionFailure).toHaveBeenCalledWith('exports/id/file.gz');
  });

  it('aborts an in-flight multipart upload before deleting its key', async () => {
    const abort = vi.fn();
    const state = {
      pendingObjectDeletions: vi
        .fn()
        .mockResolvedValue([
          { object_key: 'exports/id/file.gz', multipart_upload_id: 'upload-id' },
        ]),
      completeObjectDeletion: vi.fn(),
      recordObjectDeletionFailure: vi.fn(),
    };
    const bucket = {
      delete: vi.fn(),
      resumeMultipartUpload: vi.fn().mockReturnValue({ abort }),
    };

    await deletePendingObjects(bucket, state);

    expect(bucket.resumeMultipartUpload).toHaveBeenCalledWith('exports/id/file.gz', 'upload-id');
    expect(abort).toHaveBeenCalledOnce();
    expect(bucket.delete).toHaveBeenCalledWith('exports/id/file.gz');
    expect(state.completeObjectDeletion).toHaveBeenCalledWith('exports/id/file.gz');
  });

  it('deletes a completed object when its former multipart upload no longer exists', async () => {
    const abortError = Object.assign(new Error('missing upload'), { code: 10024 });
    const state = {
      pendingObjectDeletions: vi
        .fn()
        .mockResolvedValue([
          { object_key: 'exports/id/file.gz', multipart_upload_id: 'upload-id' },
        ]),
      completeObjectDeletion: vi.fn(),
      recordObjectDeletionFailure: vi.fn(),
    };
    const bucket = {
      delete: vi.fn(),
      resumeMultipartUpload: vi.fn().mockReturnValue({
        abort: vi.fn().mockRejectedValue(abortError),
      }),
    };

    await deletePendingObjects(bucket, state);

    expect(bucket.delete).toHaveBeenCalledWith('exports/id/file.gz');
    expect(state.completeObjectDeletion).toHaveBeenCalledWith('exports/id/file.gz');
  });
});
