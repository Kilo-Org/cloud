// A storage read the OS refused is a state the picker reports, not an empty
// list: the store's load publishes it and clears it on the next successful read.
import { describe, expect, it } from 'vitest';

import { CATALOG, harness } from './gguf-downloads.test-helpers';
import { ggufModelName } from './gguf-records';

describe('a storage read that fails', () => {
  it('reports the failure instead of an empty list and clears it on a successful load', () => {
    const h = harness();
    h.index.fails = true;

    expect(h.store.load()).toBe(false);
    expect(h.store.snapshot()).toMatchObject({ models: [], loadFailed: true });

    // A repeated failed read publishes nothing new: the render path must not see a
    // fresh snapshot for an unchanged state.
    const failed = h.store.snapshot();
    expect(h.store.load()).toBe(false);
    expect(h.store.snapshot()).toBe(failed);

    h.index.fails = false;
    h.index.text = JSON.stringify([
      {
        fileId: 'small',
        name: 'Small model',
        url: 'https://example.com/small.gguf',
        sizeBytes: 10,
        contextWindow: 4096,
        tools: false,
        vision: false,
        thinking: false,
      },
    ]);
    h.files.set(ggufModelName('small'), 10);

    expect(h.store.load()).toBe(true);
    expect(h.store.snapshot().loadFailed).toBe(false);
    expect(h.store.snapshot().models.map(model => model.fileId)).toEqual(['small']);
  });

  it('keeps a saved model entry and file when a download is attempted after a failed read', async () => {
    const h = harness();
    const saved = JSON.stringify([
      {
        fileId: 'saved',
        name: 'Saved model',
        url: 'https://example.com/saved.gguf',
        sizeBytes: 10,
        contextWindow: 4096,
        tools: false,
        vision: false,
        thinking: false,
      },
    ]);
    h.index.text = saved;
    h.files.set(ggufModelName('saved'), 10);
    h.index.fails = true;

    expect(h.store.load()).toBe(false);
    expect(h.store.snapshot().loadFailed).toBe(true);

    // The store never read the list, so it must not write it back: a download that
    // finished here would rewrite the index with only the new model, and the next
    // load would delete the saved one's file as an orphan.
    expect(h.store.start(CATALOG)).toBe(false);
    expect(h.tasks).toHaveLength(0);
    expect(h.index.text).toBe(saved);
    expect(h.files.has(ggufModelName('saved'))).toBe(true);

    // A removal would rewrite the same list.
    await h.store.remove('saved');
    expect(h.released).toEqual([]);
    expect(h.index.text).toBe(saved);
    expect(h.files.has(ggufModelName('saved'))).toBe(true);
  });
});
