// A saved list that exists but cannot be read is a read failure, not an empty
// library: publishing it as no models would tell the person their downloads are
// gone, and freeing anything would destroy models the list still names.
import { describe, expect, it } from 'vitest';

import { CATALOG, harness } from './gguf-downloads.test-helpers';
import { ggufModelName, type GgufModelRecord } from './gguf-records';

const SAVED: GgufModelRecord = {
  fileId: 'saved',
  name: 'Saved model',
  url: 'https://example.com/saved.gguf',
  sizeBytes: 10,
  contextWindow: 4096,
  tools: false,
  vision: false,
  thinking: false,
};

/** A device holding the saved model's file, with the index holding `text`. */
function withSavedModel(text: string) {
  const h = harness();
  h.index.text = text;
  h.files.set(ggufModelName(SAVED.fileId), 10);
  return h;
}

describe('a saved list the device holds but cannot be read', () => {
  it('reports a failed read for corrupt text, refuses every write, and recovers when the list parses', async () => {
    const h = withSavedModel('{ not json');
    const corrupt = h.index.text;

    expect(h.store.load()).toBe(false);
    expect(h.store.snapshot()).toMatchObject({ models: [], loadFailed: true });

    // A download whose list is unread cannot write it back: the finished list
    // would name only the new model, and the next load would delete the saved
    // one's file as an orphan. No task opens either.
    expect(h.store.start(CATALOG)).toBe(false);
    expect(h.tasks).toHaveLength(0);

    // A removal would rewrite the same list, and the model it names is not one
    // the store knows: nothing is released and no file goes.
    await expect(h.store.remove('saved')).resolves.toBeUndefined();
    expect(h.released).toEqual([]);
    expect(h.files.has(ggufModelName(SAVED.fileId))).toBe(true);

    // Cleanup never ran, so the text is exactly what the device held.
    expect(h.index.text).toBe(corrupt);

    // The list parses again, and the model it names is listed from the file the
    // device still holds.
    h.index.text = JSON.stringify([SAVED]);
    expect(h.store.load()).toBe(true);
    expect(h.store.snapshot().loadFailed).toBe(false);
    expect(h.store.snapshot().models.map(model => model.fileId)).toEqual(['saved']);
  });

  it('reports the same failed read for text that parses but is not an array', () => {
    const h = withSavedModel(JSON.stringify({ fileId: 'saved' }));
    const unreadable = h.index.text;

    expect(h.store.load()).toBe(false);
    expect(h.store.snapshot()).toMatchObject({ models: [], loadFailed: true });
    expect(h.store.start(CATALOG)).toBe(false);
    expect(h.tasks).toHaveLength(0);
    // The file the list would have named is kept, and the text is left as it is.
    expect(h.files.has(ggufModelName(SAVED.fileId))).toBe(true);
    expect(h.index.text).toBe(unreadable);
  });
});
