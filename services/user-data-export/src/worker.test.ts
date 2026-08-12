import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  consumeDeadLetterBatch,
  consumeExportBatch,
  deletePendingObjects,
  exportHeader,
  exportArtifact,
  handleFencedCompletion,
  handleGenerationFailure,
  hasRetiredGeneratorState,
  processScheduledExportWork,
  persistCompletedExport,
  recoverInterruptedMultipartUpload,
  resolveSourceAdapter,
  type ExportEnv,
} from './worker';
import { TerminalExportError } from './errors';
import type { ExportJob } from './databases';

afterEach(() => vi.restoreAllMocks());

function queueMessage(body: unknown) {
  return {
    body,
    attempts: 3,
    ack: vi.fn(),
    retry: vi.fn(),
  };
}

function parsedLog(spy: ReturnType<typeof vi.spyOn>, index = 0): Record<string, unknown> {
  return JSON.parse(String(spy.mock.calls[index]?.[0])) as Record<string, unknown>;
}

describe('queue observability', () => {
  it('logs safe retry context and keeps exception messages out of logs', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const message = queueMessage({
      version: 1,
      operation: 'generate',
      exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
      generation: 3,
    });

    await consumeExportBatch(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      {} as ExportEnv,
      vi.fn().mockRejectedValue(new Error('database secret and row contents'))
    );

    expect(parsedLog(warn)).toEqual({
      event: 'export_queue_retry_requested',
      service: 'user-data-export',
      exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
      generation: 3,
      attempt: 3,
      errorName: 'Error',
    });
    expect(warn.mock.calls[0]?.[0]).not.toContain('database secret');
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
    expect(message.ack).not.toHaveBeenCalled();
  });

  it('logs malformed messages without serializing their payload', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const message = queueMessage({ token: 'secret-token', rows: ['private'] });

    await consumeExportBatch(
      { messages: [message] } as unknown as MessageBatch<unknown>,
      {} as ExportEnv,
      vi.fn()
    );

    expect(parsedLog(warn)).toEqual({
      event: 'export_queue_message_invalid',
      service: 'user-data-export',
      validationIssueCount: expect.any(Number),
    });
    expect(warn.mock.calls[0]?.[0]).not.toContain('secret-token');
    expect(message.ack).toHaveBeenCalledOnce();
  });
});

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

describe('export artifact metadata', () => {
  it('stores a downloadable gzip object without transparent content encoding', () => {
    expect(exportArtifact).toEqual({
      contentType: 'application/gzip',
      contentDisposition: 'attachment; filename="kilo-data-export.jsonl.gz"',
    });
    expect(exportArtifact).not.toHaveProperty('contentEncoding');
  });
});

describe('source resume keys', () => {
  const enabled = {
    name: 'enabled',
    readPage: async () => ({ records: [], nextCursor: null }),
  };

  it('starts at the first enabled adapter only for a null source', () => {
    expect(
      resolveSourceAdapter([{ name: 'disabled', disabledReason: 'missing' }, enabled], null)
    ).toBe(enabled);
  });

  it('does not fall back when a persisted source key is unknown', () => {
    expect(resolveSourceAdapter([enabled], 'renamed-source')).toBeUndefined();
  });
});

describe('one-shot generator state', () => {
  it('allows generation bumps used only for stale-message fencing', () => {
    expect(
      hasRetiredGeneratorState({
        current_source: null,
        source_cursor: null,
        next_part_number: 1,
      })
    ).toBe(false);
  });

  it('rejects persisted cursor and part state from the retired generator', () => {
    expect(
      hasRetiredGeneratorState({
        current_source: 'kilocode_users',
        source_cursor: { id: 'cursor' },
        next_part_number: 2,
      })
    ).toBe(true);
  });
});

describe('generation failure handling', () => {
  it('marks terminal deadlines failed without releasing them for retry', async () => {
    const markFailed = vi.fn();
    const releaseForRetry = vi.fn();

    await expect(
      handleGenerationFailure({
        error: new TerminalExportError(
          'export_deadline_exceeded',
          'The export was too large to complete within the processing limit.',
          'deadline exceeded'
        ),
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        generation: 2,
        leaseToken: 'lease-token',
        phase: 'compression_finalize',
        source: 'microdollar_usage_prompts',
        markFailed,
        releaseForRetry,
      })
    ).resolves.toBe('failed');

    expect(markFailed).toHaveBeenCalledWith({
      exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
      generation: 2,
      leaseToken: 'lease-token',
      failureCode: 'export_deadline_exceeded',
      redactedMessage: 'The export was too large to complete within the processing limit.',
    });
    expect(releaseForRetry).not.toHaveBeenCalled();
  });

  it('keeps transient failures on the retry path', async () => {
    const markFailed = vi.fn();
    const releaseForRetry = vi.fn();

    await expect(
      handleGenerationFailure({
        error: new Error('temporary'),
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        generation: 2,
        leaseToken: 'lease-token',
        phase: 'source_read',
        source: 'microdollar_usage_prompts',
        markFailed,
        releaseForRetry,
      })
    ).resolves.toBe('retry');

    expect(markFailed).not.toHaveBeenCalled();
    expect(releaseForRetry).toHaveBeenCalledWith(
      'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
      2,
      'lease-token'
    );
  });
});

describe('interrupted multipart recovery', () => {
  it('aborts the orphan and clears its lease-fenced database reference', async () => {
    const abort = vi.fn();
    const clear = vi.fn().mockResolvedValue(true);

    await expect(recoverInterruptedMultipartUpload({ upload: { abort }, clear })).resolves.toBe(
      true
    );

    expect(abort).toHaveBeenCalledOnce();
    expect(clear).toHaveBeenCalledOnce();
  });

  it('treats a missing orphan upload as already aborted', async () => {
    const clear = vi.fn().mockResolvedValue(true);

    await expect(
      recoverInterruptedMultipartUpload({
        upload: { abort: vi.fn().mockRejectedValue({ code: 10024 }) },
        clear,
      })
    ).resolves.toBe(true);

    expect(clear).toHaveBeenCalledOnce();
  });

  it('does not clear the database reference when abort fails transiently', async () => {
    const clear = vi.fn();

    await expect(
      recoverInterruptedMultipartUpload({
        upload: { abort: vi.fn().mockRejectedValue(new Error('R2 unavailable')) },
        clear,
      })
    ).rejects.toThrow('R2 unavailable');

    expect(clear).not.toHaveBeenCalled();
  });
});

describe('completed export persistence', () => {
  it('accepts a ready row after the completion response is lost', async () => {
    await expect(
      persistCompletedExport({
        complete: vi.fn().mockRejectedValue(new Error('database response lost')),
        completedObjectMatches: vi.fn().mockResolvedValue(true),
      })
    ).resolves.toBe('already_completed');
  });

  it('rethrows an ambiguous completion when the ready object does not match', async () => {
    await expect(
      persistCompletedExport({
        complete: vi.fn().mockRejectedValue(new Error('database unavailable')),
        completedObjectMatches: vi.fn().mockResolvedValue(false),
      })
    ).rejects.toThrow('database unavailable');
  });
});

describe('fenced completion cleanup', () => {
  it('asks the database to schedule terminal object cleanup', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scheduleObjectDeletion = vi.fn().mockResolvedValue(true);

    await expect(
      handleFencedCompletion({
        exportId: 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c',
        generation: 0,
        scheduleObjectDeletion,
      })
    ).resolves.toBe(true);

    expect(scheduleObjectDeletion).toHaveBeenCalledOnce();
    expect(parsedLog(warn)).toMatchObject({
      event: 'export_completion_fenced',
      cleanupScheduled: true,
    });
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
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const exportId = 'f6ba5ce5-9061-4f7f-9ec6-76f047573f1c';
    const objectKey = `exports/${exportId}/kilo-data-export.jsonl.gz`;
    const state = {
      pendingObjectDeletions: vi
        .fn()
        .mockResolvedValue([{ object_key: objectKey, multipart_upload_id: null }]),
      completeObjectDeletion: vi.fn(),
      recordObjectDeletionFailure: vi.fn(),
    };
    const bucket = {
      delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
      resumeMultipartUpload: vi.fn(),
    };

    await deletePendingObjects(bucket, state);

    expect(state.completeObjectDeletion).not.toHaveBeenCalled();
    expect(state.recordObjectDeletionFailure).toHaveBeenCalledWith(objectKey);
    expect(parsedLog(warn)).toEqual({
      event: 'account_export_object_cleanup_failed',
      service: 'user-data-export',
      exportId,
      stage: 'r2_delete',
      errorName: 'Error',
    });
    expect(warn.mock.calls[0]?.[0]).not.toContain(objectKey);
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

describe('scheduled export maintenance isolation', () => {
  it('continues to multipart cleanup and outbox dispatch after an expiry delete fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const abort = vi.fn();
    const send = vi.fn();
    const state = {
      expiredObjects: vi
        .fn()
        .mockResolvedValue([{ id: 'expired-id', r2_object_key: 'exports/expired/file.gz' }]),
      markExpired: vi.fn(),
      failedMultipartUploads: vi
        .fn()
        .mockResolvedValue([{ id: 'failed-id', multipart_upload_id: 'upload-id' }]),
      clearMultipartUpload: vi.fn(),
      pendingOutbox: vi
        .fn()
        .mockResolvedValue([{ id: 'outbox-id', export_id: 'export-id', generation: 2 }]),
      markOutboxSent: vi.fn(),
      recordOutboxFailure: vi.fn(),
    };
    const env = {
      EXPORT_BUCKET: {
        delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
        resumeMultipartUpload: vi.fn().mockReturnValue({ abort }),
      },
      EXPORT_QUEUE: { send },
    };

    await processScheduledExportWork(env, state);

    expect(state.markExpired).not.toHaveBeenCalled();
    expect(abort).toHaveBeenCalledOnce();
    expect(state.clearMultipartUpload).toHaveBeenCalledWith('failed-id');
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ exportId: 'export-id', generation: 2 })
    );
    expect(state.markOutboxSent).toHaveBeenCalledWith('outbox-id');
    expect(state.recordOutboxFailure).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('clears a failed multipart reference when the upload is already missing', async () => {
    const state = {
      expiredObjects: vi.fn().mockResolvedValue([]),
      markExpired: vi.fn(),
      failedMultipartUploads: vi
        .fn()
        .mockResolvedValue([{ id: 'failed-id', multipart_upload_id: 'upload-id' }]),
      clearMultipartUpload: vi.fn(),
      pendingOutbox: vi.fn().mockResolvedValue([]),
      markOutboxSent: vi.fn(),
      recordOutboxFailure: vi.fn(),
    };
    const env = {
      EXPORT_BUCKET: {
        delete: vi.fn(),
        resumeMultipartUpload: vi.fn().mockReturnValue({
          abort: vi.fn().mockRejectedValue({ name: 'NoSuchUpload' }),
        }),
      },
      EXPORT_QUEUE: { send: vi.fn() },
    };

    await processScheduledExportWork(env, state);

    expect(state.clearMultipartUpload).toHaveBeenCalledWith('failed-id');
  });

  it('continues to outbox dispatch after a failed multipart abort', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi.fn();
    const state = {
      expiredObjects: vi.fn().mockResolvedValue([]),
      markExpired: vi.fn(),
      failedMultipartUploads: vi
        .fn()
        .mockResolvedValue([{ id: 'failed-id', multipart_upload_id: 'upload-id' }]),
      clearMultipartUpload: vi.fn(),
      pendingOutbox: vi
        .fn()
        .mockResolvedValue([{ id: 'outbox-id', export_id: 'export-id', generation: 2 }]),
      markOutboxSent: vi.fn(),
      recordOutboxFailure: vi.fn(),
    };
    const env = {
      EXPORT_BUCKET: {
        delete: vi.fn(),
        resumeMultipartUpload: vi.fn().mockReturnValue({
          abort: vi.fn().mockRejectedValue(new Error('R2 unavailable')),
        }),
      },
      EXPORT_QUEUE: { send },
    };

    await processScheduledExportWork(env, state);

    expect(state.clearMultipartUpload).not.toHaveBeenCalled();
    expect(send).toHaveBeenCalledWith(
      expect.objectContaining({ exportId: 'export-id', generation: 2 })
    );
    expect(state.markOutboxSent).toHaveBeenCalledWith('outbox-id');
    expect(state.recordOutboxFailure).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('backs off a failed outbox send without blocking later rows', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const send = vi
      .fn()
      .mockRejectedValueOnce(new Error('Queue unavailable'))
      .mockResolvedValueOnce(undefined);
    const state = {
      expiredObjects: vi.fn().mockResolvedValue([]),
      markExpired: vi.fn(),
      failedMultipartUploads: vi.fn().mockResolvedValue([]),
      clearMultipartUpload: vi.fn(),
      pendingOutbox: vi.fn().mockResolvedValue([
        { id: 'outbox-1', export_id: 'export-1', generation: 1 },
        { id: 'outbox-2', export_id: 'export-2', generation: 2 },
      ]),
      markOutboxSent: vi.fn(),
      recordOutboxFailure: vi.fn(),
    };
    const env = {
      EXPORT_BUCKET: { delete: vi.fn(), resumeMultipartUpload: vi.fn() },
      EXPORT_QUEUE: { send },
    };

    await processScheduledExportWork(env, state);

    expect(state.recordOutboxFailure).toHaveBeenCalledWith('outbox-1');
    expect(state.markOutboxSent).toHaveBeenCalledWith('outbox-2');
    warn.mockRestore();
  });
});
