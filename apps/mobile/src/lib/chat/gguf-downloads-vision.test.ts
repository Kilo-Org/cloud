/* eslint-disable typescript-eslint/require-await, require-await -- a download is a pending promise the test settles by hand */
import { describe, expect, it } from 'vitest';

import { finish, flush, harness, MODEL, taskAt } from './gguf-downloads.test-helpers';
import {
  ggufModelName,
  type GgufModelRecord,
  ggufPartialName,
  ggufProjectorName,
  ggufProjectorPartialName,
  STORAGE_HEADROOM_BYTES,
} from './gguf-records';

const VISION = {
  ...MODEL,
  fileId: 'eyes',
  name: 'Eyes',
  url: 'https://example.com/eyes.gguf',
  projector: {
    url: 'https://example.com/mmproj-eyes.gguf',
    sizeBytes: 200,
    sha256: 'b'.repeat(64),
  },
};

const VISION_CATALOG = { kind: 'catalog', model: VISION } as const;

describe('downloading a vision model', () => {
  it('downloads the projector after the model as one download, and lists it as reading images', async () => {
    const h = harness();
    expect(h.store.start(VISION_CATALOG)).toBe(true);
    expect(h.store.snapshot().download).toMatchObject({ written: 0, total: 1200 });
    taskAt(h.tasks, 0).progress({ bytesWritten: 400, totalBytes: 1000 });
    expect(h.store.snapshot().download).toMatchObject({ written: 400, total: 1200 });
    await finish(taskAt(h.tasks, 0), 1000);

    expect(h.tasks).toHaveLength(2);
    expect(taskAt(h.tasks, 1)).toMatchObject({
      url: VISION.projector.url,
      name: ggufProjectorPartialName('eyes'),
    });
    expect(h.inspected).toEqual([]);
    taskAt(h.tasks, 1).progress({ bytesWritten: 50, totalBytes: 200 });
    expect(h.store.snapshot().download).toMatchObject({
      phase: 'downloading',
      written: 1050,
      total: 1200,
    });
    await finish(taskAt(h.tasks, 1), 200);

    expect(h.inspected).toEqual(['/models/eyes.gguf.part']);
    expect(h.projectors).toEqual(['/models/eyes.mmproj.gguf.part']);
    expect([...h.files.keys()].toSorted()).toEqual([
      ggufModelName('eyes'),
      ggufProjectorName('eyes'),
    ]);
    expect(h.store.model('eyes')).toMatchObject({ sizeBytes: 1200, vision: true });
    expect(h.store.file('eyes')).toEqual({
      path: '/models/eyes.gguf',
      contextWindow: 4096,
      tools: true,
      projector: '/models/eyes.mmproj.gguf',
    });
  });

  it('checks storage against the model and its projector together', () => {
    const h = harness({ freeBytes: STORAGE_HEADROOM_BYTES + 1100 });
    expect(h.store.start(VISION_CATALOG)).toBe(false);
    expect(h.tasks).toHaveLength(0);
    expect(h.store.snapshot().failure).toEqual({ fileId: 'eyes', problem: 'space' });
  });

  it('removes both partial files when the projector transfer is cancelled', async () => {
    const h = harness();
    h.store.start(VISION_CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    taskAt(h.tasks, 1).progress({ bytesWritten: 20, totalBytes: 200 });
    h.store.cancel('eyes');
    await flush();
    expect(h.store.snapshot().download).toBeNull();
    expect(h.files.size).toBe(0);
  });

  it('removes both partial files when the projector transfer fails', async () => {
    const h = harness();
    h.store.start(VISION_CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    taskAt(h.tasks, 1).fail();
    await flush();
    expect(h.store.snapshot().failure).toEqual({ fileId: 'eyes', problem: 'network' });
    expect(h.files.size).toBe(0);
  });

  it('starts only the projector again when the server refuses its resume', async () => {
    const h = harness();
    h.store.start(VISION_CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    taskAt(h.tasks, 1).progress({ bytesWritten: 80, totalBytes: 200 });
    h.store.pause('eyes');
    taskAt(h.tasks, 1).settle(null);
    await flush();
    expect(h.store.snapshot().download).toMatchObject({ phase: 'paused', written: 1080 });
    h.store.resume('eyes');
    taskAt(h.tasks, 1).fail();
    await flush();
    expect(h.tasks).toHaveLength(3);
    expect(taskAt(h.tasks, 2).url).toBe(VISION.projector.url);
    expect(h.files.get(ggufPartialName('eyes'))).toBe(1000);
    expect(h.store.snapshot().download).toMatchObject({ written: 1000, total: 1200 });
    await finish(taskAt(h.tasks, 2), 200);
    expect(h.store.model('eyes')?.vision).toBe(true);
  });

  it('refuses a projector whose bytes do not match the published size', async () => {
    const h = harness();
    h.store.start(VISION_CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    await finish(taskAt(h.tasks, 1), 150);
    expect(h.store.snapshot().failure).toEqual({ fileId: 'eyes', problem: 'invalidFile' });
    expect(h.files.size).toBe(0);
  });

  it('refuses a projector llama.cpp does not read images with, and keeps nothing', async () => {
    const h = harness({
      inspection: async () => ({ contextWindow: 4096, tools: false, vision: false }),
    });
    h.store.start(VISION_CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    await finish(taskAt(h.tasks, 1), 200);
    expect(h.store.snapshot().failure).toEqual({ fileId: 'eyes', problem: 'invalidFile' });
    expect(h.files.size).toBe(0);
    expect(h.store.model('eyes')).toBeUndefined();
  });

  it('keeps no model file when its projector cannot be moved into place', async () => {
    const h = harness({ failMove: ggufProjectorName('eyes') });
    h.store.start(VISION_CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    await finish(taskAt(h.tasks, 1), 200);
    expect(h.store.snapshot().failure).toEqual({ fileId: 'eyes', problem: 'invalidFile' });
    expect(h.files.size).toBe(0);
  });

  it('deletes the projector with the model', async () => {
    const h = harness();
    h.store.start(VISION_CATALOG);
    await finish(taskAt(h.tasks, 0), 1000);
    await finish(taskAt(h.tasks, 1), 200);
    await h.store.remove('eyes');
    expect(h.released).toEqual(['eyes']);
    expect(h.files.size).toBe(0);
    expect(h.store.snapshot().models).toEqual([]);
  });

  it('drops a saved vision model whose projector is gone, with its model file', () => {
    const h = harness();
    const saved: GgufModelRecord = {
      fileId: 'eyes',
      name: 'Eyes',
      url: VISION.url,
      sizeBytes: 1200,
      contextWindow: 4096,
      tools: false,
      vision: true,
    };
    h.index.text = JSON.stringify([saved]);
    h.files.set(ggufModelName('eyes'), 1000);

    h.store.load();
    // The rewritten list no longer names the file, so the next launch deletes it.
    h.store.load();

    expect(h.store.snapshot().models).toEqual([]);
    expect(h.files.size).toBe(0);
  });

  it('reads a model saved before projectors existed as text-only', () => {
    const h = harness();
    h.index.text = JSON.stringify([
      {
        fileId: 'old',
        name: 'Old',
        url: 'https://example.com/old.gguf',
        sizeBytes: 10,
        contextWindow: 4096,
        tools: true,
      },
    ]);
    h.files.set(ggufModelName('old'), 10);

    h.store.load();

    expect(h.store.model('old')?.vision).toBe(false);
    expect(h.store.file('old')?.projector).toBeUndefined();
    expect(h.files.has(ggufModelName('old'))).toBe(true);
  });
});
