import { describe, expect, it } from 'vitest';

import {
  attachmentQueueReducer,
  selectHasFailed,
  selectIsUploading,
  selectReadyBlocks,
  type AttachmentQueueAction,
  type AttachmentQueueState,
  type QueuedAttachment,
} from './use-attachment-queue';

function row(overrides: Partial<QueuedAttachment> = {}): QueuedAttachment {
  return {
    tempId: 'tmp-1',
    filename: 'a.png',
    mimeType: 'image/png',
    size: 100,
    status: 'uploading',
    progress: 0,
    attachmentId: undefined,
    error: undefined,
    ...overrides,
  };
}

function state(rows: QueuedAttachment[]): AttachmentQueueState {
  return { rows };
}

function reduce(s: AttachmentQueueState, a: AttachmentQueueAction): AttachmentQueueState {
  return attachmentQueueReducer(s, a);
}

describe('attachmentQueueReducer', () => {
  it('add appends a new row in uploading status', () => {
    const next = reduce(state([]), {
      type: 'add',
      row: row({ tempId: 'tmp-1' }),
    });
    expect(next.rows.map(r => r.tempId)).toEqual(['tmp-1']);
    expect(next.rows[0]?.status).toBe('uploading');
  });

  it('setInited stores the attachmentId on the matching row', () => {
    const s = state([row({ tempId: 'tmp-1' })]);
    const next = reduce(s, {
      type: 'setInited',
      tempId: 'tmp-1',
      attachmentId: '01HV0000000000000000000001',
    });
    expect(next.rows[0]?.attachmentId).toBe('01HV0000000000000000000001');
  });

  it('setProgress clamps to [0, 1] and updates the right row', () => {
    const s = state([row({ tempId: 'tmp-1' }), row({ tempId: 'tmp-2' })]);
    const next = reduce(s, { type: 'setProgress', tempId: 'tmp-2', progress: 1.5 });
    expect(next.rows[0]?.progress).toBe(0);
    expect(next.rows[1]?.progress).toBe(1);
  });

  it('setReady transitions row to ready and pins progress to 1', () => {
    const s = state([row({ tempId: 'tmp-1', progress: 0.7 })]);
    const next = reduce(s, { type: 'setReady', tempId: 'tmp-1' });
    expect(next.rows[0]?.status).toBe('ready');
    expect(next.rows[0]?.progress).toBe(1);
  });

  it('setFailed records the error and marks failed', () => {
    const s = state([row({ tempId: 'tmp-1' })]);
    const next = reduce(s, { type: 'setFailed', tempId: 'tmp-1', error: 'boom' });
    expect(next.rows[0]?.status).toBe('failed');
    expect(next.rows[0]?.error).toBe('boom');
  });

  it('retry resets progress and status to uploading, clears error', () => {
    const s = state([row({ tempId: 'tmp-1', status: 'failed', error: 'boom', progress: 0.4 })]);
    const next = reduce(s, { type: 'retry', tempId: 'tmp-1' });
    expect(next.rows[0]?.status).toBe('uploading');
    expect(next.rows[0]?.progress).toBe(0);
    expect(next.rows[0]?.error).toBeUndefined();
  });

  it('remove drops the row', () => {
    const s = state([row({ tempId: 'tmp-1' }), row({ tempId: 'tmp-2' })]);
    const next = reduce(s, { type: 'remove', tempId: 'tmp-1' });
    expect(next.rows.map(r => r.tempId)).toEqual(['tmp-2']);
  });

  it('clear empties the queue', () => {
    const s = state([row({ tempId: 'tmp-1' }), row({ tempId: 'tmp-2' })]);
    const next = reduce(s, { type: 'clear' });
    expect(next.rows).toEqual([]);
  });

  it('clearFiles removes only submitted attachment rows', () => {
    const s = state([row({ tempId: 'submitted' }), row({ tempId: 'next-message' })]);
    const next = reduce(s, { type: 'clearFiles', tempIds: ['submitted'] });
    expect(next.rows.map(r => r.tempId)).toEqual(['next-message']);
  });
});

describe('queue selectors', () => {
  it('selectReadyBlocks returns only ready rows with attachmentId, mapped to AttachmentBlock', () => {
    const rows: QueuedAttachment[] = [
      row({ tempId: 'a', status: 'ready', attachmentId: '01HV0000000000000000000001' }),
      row({ tempId: 'b', status: 'uploading' }),
      row({ tempId: 'c', status: 'ready', attachmentId: undefined }),
      row({
        tempId: 'd',
        status: 'ready',
        attachmentId: '01HV0000000000000000000002',
        filename: 'x.bin',
        mimeType: 'application/octet-stream',
        size: 1234,
      }),
    ];
    expect(selectReadyBlocks(rows)).toEqual([
      {
        type: 'attachment',
        attachmentId: '01HV0000000000000000000001',
        mimeType: 'image/png',
        size: 100,
        filename: 'a.png',
      },
      {
        type: 'attachment',
        attachmentId: '01HV0000000000000000000002',
        mimeType: 'application/octet-stream',
        size: 1234,
        filename: 'x.bin',
      },
    ]);
  });

  it('selectIsUploading is true when any row is uploading', () => {
    expect(selectIsUploading([row({ status: 'ready' }), row({ status: 'uploading' })])).toBe(true);
    expect(selectIsUploading([row({ status: 'ready' }), row({ status: 'failed' })])).toBe(false);
    expect(selectIsUploading([])).toBe(false);
  });

  it('selectHasFailed is true when any row is failed', () => {
    expect(selectHasFailed([row({ status: 'ready' }), row({ status: 'failed' })])).toBe(true);
    expect(selectHasFailed([row({ status: 'ready' }), row({ status: 'uploading' })])).toBe(false);
  });
});
