import { describe, expect, it } from 'vitest';

import { CATALOG, finish, harness, taskAt } from './gguf-downloads.test-helpers';
import { ggufModelName } from './gguf-records';

describe('a listener that throws as a download ends', () => {
  it('keeps the model the saved list names and still notifies the other listeners', async () => {
    const h = harness();
    h.store.subscribe(() => {
      const { models, download, failure } = h.store.snapshot();
      if (download === null && models.length > 0 && failure === null) {
        throw new Error('render failed');
      }
    });
    let finished = 0;
    h.store.subscribe(() => {
      const { models, download, failure } = h.store.snapshot();
      if (download === null && models.length > 0 && failure === null) {
        finished += 1;
      }
    });

    expect(h.store.start(CATALOG)).toBe(true);
    await finish(taskAt(h.tasks, 0), 1000);

    expect(h.store.snapshot().models.map(model => model.fileId)).toEqual(['small']);
    expect(h.files.has(ggufModelName('small'))).toBe(true);
    expect(h.store.snapshot().failure).toBeNull();
    expect(finished).toBe(1);
  });
});
