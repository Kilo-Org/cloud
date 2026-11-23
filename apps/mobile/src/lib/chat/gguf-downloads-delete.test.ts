/* eslint-disable typescript-eslint/require-await, require-await, promise-function-async, promise/prefer-await-to-then -- a download is a pending promise the test settles by hand */
import { describe, expect, it, vi } from 'vitest';

import { CATALOG, finish, harness, taskAt } from './gguf-downloads.test-helpers';
import { ggufModelName, RELEASE_WAIT_MS } from './gguf-records';

describe('deleting a model', () => {
  it('releases the loaded context first, then the file and the list entry', async () => {
    const h = harness();
    h.store.start(CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    await h.store.remove('small');
    expect(h.released).toEqual(['small']);
    expect(h.files.has(ggufModelName('small'))).toBe(false);
    expect(h.store.snapshot().models).toEqual([]);
  });

  it('does nothing for a model that is not downloaded', async () => {
    const h = harness();
    await h.store.remove('missing');
    expect(h.released).toEqual([]);
  });

  /* A native release can stay pending for good, which is why a load bounds its
     wait. The delete has to bound the same wait: the person asked for the files
     to go, and no other path frees the space. */
  it('deletes the files anyway when the release never settles', async () => {
    const h = harness({ stallRelease: true });
    h.store.start(CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    // Installed only around the delete: the download above awaits a real timer.
    vi.useFakeTimers();
    try {
      const removed = h.store.remove('small');
      await vi.advanceTimersByTimeAsync(RELEASE_WAIT_MS);
      await removed;
      expect(h.released).toEqual(['small']);
      expect(h.files.has(ggufModelName('small'))).toBe(false);
      expect(h.store.snapshot().models).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});
