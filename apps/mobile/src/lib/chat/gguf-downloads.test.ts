/* eslint-disable typescript-eslint/require-await, require-await, promise-function-async, promise/prefer-await-to-then -- a download is a pending promise the test settles by hand */
import { describe, expect, it } from 'vitest';

import { CATALOG, finish, flush, harness, taskAt } from './gguf-downloads.test-helpers';
import { ggufModelName, type GgufModelRecord, ggufPartialName } from './gguf-records';

describe('downloading a curated model', () => {
  it('reports progress, verifies the file, and lists what the file says', async () => {
    const h = harness();
    expect(h.store.start(CATALOG)).toBe(true);
    expect(h.store.snapshot().download).toMatchObject({
      fileId: 'small',
      phase: 'downloading',
      total: 1000,
    });
    taskAt(h.tasks, 0).progress({ bytesWritten: 400, totalBytes: 1000 });
    expect(h.store.snapshot().download?.written).toBe(400);
    await finish(taskAt(h.tasks, 0), 1000);
    expect(h.inspected).toEqual(['/models/small.gguf.part']);
    expect(h.files.has(ggufModelName('small'))).toBe(true);
    expect(h.files.has(ggufPartialName('small'))).toBe(false);
    expect(h.store.snapshot().download).toBeNull();
    expect(h.store.model('small')).toMatchObject({
      sizeBytes: 1000,
      contextWindow: 4096,
      tools: true,
    });
    expect(JSON.parse(h.index.text ?? '[]')).toHaveLength(1);
  });

  it('refuses a second download while one runs, and a model already here', () => {
    const h = harness();
    expect(h.store.start(CATALOG)).toBe(true);
    expect(h.store.start(CATALOG)).toBe(false);
    expect(h.tasks).toHaveLength(1);
  });

  it('refuses before starting when storage has no room', () => {
    const h = harness({ freeBytes: 1000 });
    expect(h.store.start(CATALOG)).toBe(false);
    expect(h.tasks).toHaveLength(0);
    expect(h.store.snapshot().failure).toEqual({ fileId: 'small', problem: 'space' });
  });

  it('stops a direct link the moment the server states a length that does not fit', async () => {
    const h = harness({ freeBytes: 2_000_000_000 });
    const linked = {
      kind: 'url',
      fileId: 'url-1',
      name: 'Linked',
      url: 'https://example.com/big.gguf',
    } as const;
    expect(h.store.start(linked)).toBe(true);
    taskAt(h.tasks, 0).progress({ bytesWritten: 1, totalBytes: 4_000_000_000 });
    await flush();
    expect(h.store.snapshot().failure).toEqual({ fileId: 'url-1', problem: 'space' });
    expect(h.store.snapshot().download).toBeNull();
    expect(h.files.size).toBe(0);
  });
});

describe('pausing, resuming and cancelling', () => {
  it('pauses on request and keeps the bytes for the resume', async () => {
    const h = harness();
    h.store.start(CATALOG);
    taskAt(h.tasks, 0).progress({ bytesWritten: 300, totalBytes: 1000 });
    h.store.pause('small');
    expect(taskAt(h.tasks, 0).paused).toHaveBeenCalled();
    taskAt(h.tasks, 0).settle(null);
    await flush();
    expect(h.store.snapshot().download?.phase).toBe('paused');
    expect(h.store.snapshot().download?.written).toBe(300);
    h.store.resume('small');
    expect(h.store.snapshot().download?.phase).toBe('downloading');
    await finish(taskAt(h.tasks, 0), 1000);
    expect(h.store.model('small')).toBeDefined();
  });

  it('starts once more from the first byte when the server refuses the resume', async () => {
    const h = harness();
    h.store.start(CATALOG);
    taskAt(h.tasks, 0).progress({ bytesWritten: 300, totalBytes: 1000 });
    h.store.pause('small');
    taskAt(h.tasks, 0).settle(null);
    await flush();
    h.store.resume('small');
    taskAt(h.tasks, 0).fail();
    await flush();
    expect(h.tasks).toHaveLength(2);
    expect(h.store.snapshot().download?.written).toBe(0);
    await finish(taskAt(h.tasks, 1), 1000);
    expect(h.store.model('small')).toBeDefined();
  });

  it('removes the partial file when the download is cancelled', async () => {
    const h = harness();
    h.store.start(CATALOG);
    taskAt(h.tasks, 0).progress({ bytesWritten: 100, totalBytes: 1000 });
    h.store.cancel('small');
    await flush();
    expect(h.store.snapshot().download).toBeNull();
    expect(h.files.size).toBe(0);
    expect(h.store.model('small')).toBeUndefined();
  });

  it('removes the partial file and says why when the download fails', async () => {
    const h = harness();
    h.store.start(CATALOG);
    taskAt(h.tasks, 0).fail();
    await flush();
    expect(h.store.snapshot()).toMatchObject({
      download: null,
      failure: { fileId: 'small', problem: 'network' },
    });
    expect(h.files.size).toBe(0);
  });

  it('refuses a file llama.cpp cannot read, and keeps nothing', async () => {
    const h = harness({ inspection: () => Promise.reject(new Error('not a model')) });
    h.store.start(CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    expect(h.store.snapshot().failure).toEqual({ fileId: 'small', problem: 'invalidFile' });
    expect(h.files.size).toBe(0);
    expect(h.store.model('small')).toBeUndefined();
  });

  it('refuses a file whose bytes do not match the published size', async () => {
    const h = harness();
    h.store.start(CATALOG);
    await finish(taskAt(h.tasks, 0), 900);
    expect(h.store.snapshot().failure).toEqual({ fileId: 'small', problem: 'invalidFile' });
    expect(h.files.size).toBe(0);
  });
});

describe('the saved list', () => {
  it('keeps every file the list names and deletes only what it never names', () => {
    const h = harness();
    const saved: GgufModelRecord = {
      fileId: 'here',
      name: 'Here',
      url: 'https://example.com/h.gguf',
      sizeBytes: 10,
      contextWindow: 4096,
      tools: false,
      vision: false,
    };
    // The second entry has a shape this build cannot read, and still names a file.
    h.index.text = JSON.stringify([saved, { fileId: 'other', name: 'Other' }]);
    h.files.set(ggufModelName('here'), 10);
    h.files.set(ggufModelName('other'), 20);
    h.files.set(ggufModelName('orphan'), 30);
    h.files.set(ggufPartialName('old'), 5);

    h.store.load();

    expect(h.store.snapshot().models.map(model => model.fileId)).toEqual(['here']);
    expect([...h.files.keys()].toSorted()).toEqual(['here.gguf', 'other.gguf']);
  });
});

it.each([
  ['{"fileId":"other"}', 'an entry this build cannot read'],
  ['{ not json', 'a list that does not parse at all'],
])('leaves %s alone, so the next launch still protects the file', text => {
  const h = harness();
  h.index.text = text;
  h.files.set(ggufModelName('other'), 20);

  // Two loads stand in for two launches.
  h.store.load();
  h.store.load();

  expect(h.index.text).toBe(text);
  expect(h.files.has(ggufModelName('other'))).toBe(true);
});

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
});
