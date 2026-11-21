/* eslint-disable typescript-eslint/require-await, require-await, promise-function-async, promise/prefer-await-to-then -- a download is a pending promise the test settles by hand */
import { describe, expect, it } from 'vitest';

import { CATALOG, finish, flush, harness, taskAt } from './gguf-downloads.test-helpers';
import { ggufPartialName } from './gguf-records';

// A device that refuses a storage call is not a device that ran out of room:
// a permission or I/O refusal gets its own problem and its own copy.
describe('a device that refuses a storage call at the last step', () => {
  it('reports the write failure when the finished file cannot be sized', async () => {
    const h = harness({ sizeFails: ggufPartialName('small') });
    h.store.start(CATALOG);

    await finish(taskAt(h.tasks, 0), 1000);

    // The download ended with its own problem, and the partial file it wrote
    // went with the failure: the row does not stay at verifying.
    expect(h.store.snapshot()).toMatchObject({
      models: [],
      download: null,
      failure: { fileId: 'small', problem: 'writeFailed' },
    });
    expect(h.files.size).toBe(0);
    expect(h.store.model('small')).toBeUndefined();
  });

  it('reports the write failure when the device will not open the transfer', () => {
    const h = harness({ createDownloadFailsAt: 1 });

    expect(h.store.start(CATALOG)).toBe(false);

    // No row was ever started, and the refusal is named for what it is.
    expect(h.store.snapshot()).toMatchObject({
      models: [],
      download: null,
      failure: { fileId: 'small', problem: 'writeFailed' },
    });
    expect(h.tasks).toHaveLength(0);
    expect(h.files.size).toBe(0);
  });
});

describe('the space problem stays for an actual storage-space stop', () => {
  it('refuses before starting when storage has no room', () => {
    const h = harness({ freeBytes: 1000 });

    expect(h.store.start(CATALOG)).toBe(false);

    expect(h.store.snapshot().failure).toEqual({ fileId: 'small', problem: 'space' });
    expect(h.tasks).toHaveLength(0);
  });

  it('reports space, not a write failure, when the finished list cannot be saved', async () => {
    const h = harness();
    h.store.start(CATALOG);
    h.index.writeFails = true;

    await finish(taskAt(h.tasks, 0), 1000);

    expect(h.store.snapshot()).toMatchObject({
      models: [],
      download: null,
      failure: { fileId: 'small', problem: 'space' },
    });
    expect(h.files.size).toBe(0);
  });
});

describe('a transfer the device will not open again', () => {
  it('reports the write failure instead of a network problem', async () => {
    const h = harness({ createDownloadFailsAt: 2 });
    h.store.start(CATALOG);
    // A pause, then a resume the server refuses: the store starts the transfer
    // again from zero, and the device will not open it the second time.
    h.store.pause('small');
    taskAt(h.tasks, 0).settle(null);
    await flush();
    h.store.resume('small');
    taskAt(h.tasks, 0).fail();

    await flush();

    expect(h.store.snapshot()).toMatchObject({
      models: [],
      download: null,
      failure: { fileId: 'small', problem: 'writeFailed' },
    });
    expect(h.files.size).toBe(0);
  });
});
