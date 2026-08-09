import { describe, expect, it, vi } from 'vitest';
import { consumeDeadLetterBatch, deletePendingObjects, type ExportEnv } from './worker';

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

describe('account-deletion object cleanup', () => {
  it('removes a tombstone only after R2 deletion succeeds', async () => {
    const state = {
      pendingObjectDeletions: vi.fn().mockResolvedValue([{ object_key: 'exports/id/file.gz' }]),
      completeObjectDeletion: vi.fn(),
      recordObjectDeletionFailure: vi.fn(),
    };
    const bucket = { delete: vi.fn() };

    await deletePendingObjects(bucket, state);

    expect(bucket.delete).toHaveBeenCalledWith('exports/id/file.gz');
    expect(state.completeObjectDeletion).toHaveBeenCalledWith('exports/id/file.gz');
    expect(state.recordObjectDeletionFailure).not.toHaveBeenCalled();
  });

  it('retains the tombstone and records a failed R2 deletion attempt', async () => {
    const state = {
      pendingObjectDeletions: vi.fn().mockResolvedValue([{ object_key: 'exports/id/file.gz' }]),
      completeObjectDeletion: vi.fn(),
      recordObjectDeletionFailure: vi.fn(),
    };
    const bucket = { delete: vi.fn().mockRejectedValue(new Error('R2 unavailable')) };

    await deletePendingObjects(bucket, state);

    expect(state.completeObjectDeletion).not.toHaveBeenCalled();
    expect(state.recordObjectDeletionFailure).toHaveBeenCalledWith('exports/id/file.gz');
  });
});
