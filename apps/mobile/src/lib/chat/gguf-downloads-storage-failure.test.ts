/* eslint-disable typescript-eslint/require-await, require-await, promise-function-async, promise/prefer-await-to-then -- a download is a pending promise the test settles by hand */
// A storage read the OS refused is a state the picker reports, not an empty
// list: the store's load publishes it and clears it on the next successful read.
import { describe, expect, it } from 'vitest';

import { harness } from './gguf-downloads.test-helpers';
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
});
