/* eslint-disable typescript-eslint/require-await, require-await, promise-function-async, promise/prefer-await-to-then -- a download is a pending promise the test settles by hand */
import { describe, expect, it } from 'vitest';

import { CATALOG, finish, harness, taskAt } from './gguf-downloads.test-helpers';
import { ggufModelName } from './gguf-records';

describe('a saved list the device will not take', () => {
  it('reports the finished download as failed instead of leaving it at verifying', async () => {
    const h = harness();
    h.store.start(CATALOG);
    h.index.writeFails = true;

    await finish(taskAt(h.tasks, 0), 1000);

    // The record never reached the device, so the model is not on it: the files
    // go with the failure and the row stops asking for a verification.
    expect(h.store.snapshot()).toMatchObject({
      models: [],
      download: null,
      failure: { fileId: 'small', problem: 'space' },
    });
    expect(h.files.size).toBe(0);
    expect(h.index.text).toBeNull();
    expect(h.store.model('small')).toBeUndefined();
  });

  it('drops a deleted model from the list even when the write fails', async () => {
    const h = harness();
    h.store.start(CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    const saved = h.index.text;
    h.index.writeFails = true;

    await h.store.remove('small');

    expect(h.store.snapshot().models).toEqual([]);
    expect(h.files.has(ggufModelName('small'))).toBe(false);
    // The saved list still names it; the next load drops the entry whose file is gone.
    expect(h.index.text).toBe(saved);
  });
});
