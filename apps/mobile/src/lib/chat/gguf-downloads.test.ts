/* eslint-disable typescript-eslint/consistent-type-assertions, typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-return, typescript-eslint/require-await, require-await, promise-function-async, promise/prefer-await-to-then -- a llama.rn context is a JSI object and a download is a pending promise: a test double can only be built by asserting its shape */
import { describe, expect, it, vi } from 'vitest';

import { ggufDownloads } from './gguf-downloads';
import {
  type GgufDownloadedFile,
  type GgufDownloadTask,
  type GgufInspection,
  ggufModelName,
  type GgufModelRecord,
  ggufPartialName,
  type GgufStorage,
} from './gguf-records';

type Progress = (progress: {
  readonly bytesWritten: number;
  readonly totalBytes: number;
}) => void;

/** The task at a known position, so the assertions need no non-null assertion. */
function taskAt(tasks: readonly Task[], index: number): Task {
  const found = tasks[index];
  if (found === undefined) {
    throw new Error(`no download task at ${index}`);
  }
  return found;
}

type Task = {
  readonly url: string;
  readonly name: string;
  readonly progress: Progress;
  settle: (value: GgufDownloadedFile | null) => void;
  fail: () => void;
  readonly paused: ReturnType<typeof vi.fn>;
};

/** The file system and the downloads the store asked for, in memory. */
function harness(
  options: { readonly freeBytes?: number; readonly inspection?: () => Promise<GgufInspection> } = {}
) {
  const freeBytes = options.freeBytes ?? 8_000_000_000;
  const files = new Map<string, number>();
  const index: { text: string | null } = { text: null };
  const tasks: Task[] = [];
  const inspected: string[] = [];
  const released: string[] = [];

  const storage: GgufStorage = {
    freeBytes: () => freeBytes,
    list: () => [...files.keys()],
    size: name => files.get(name) ?? 0,
    remove: name => {
      files.delete(name);
    },
    move: (from, to) => {
      const size = files.get(from) ?? 0;
      files.delete(from);
      files.set(to, size);
    },
    path: name => `/models/${name}`,
    readIndex: () => index.text,
    writeIndex: text => {
      index.text = text;
    },
    createDownload: (url, name, report) => {
      const progress: Progress = bytes => {
        files.set(name, bytes.bytesWritten);
        report(bytes);
      };
      // A resume starts a fresh transfer, so it hands back a fresh promise.
      let current = Promise.withResolvers<GgufDownloadedFile | null>();
      const paused = vi.fn();
      const task: Task = {
        url,
        name,
        progress,
        settle: value => {
          current.resolve(value);
        },
        fail: () => {
          current.reject(new Error('download failed'));
        },
        paused,
      };
      tasks.push(task);
      files.set(name, 0);
      return {
        downloadAsync: () => current.promise,
        resumeAsync: () => {
          current = Promise.withResolvers<GgufDownloadedFile | null>();
          return current.promise;
        },
        pause: () => {
          paused();
        },
        cancel: () => {
          current.reject(new Error('download cancelled'));
        },
      } satisfies GgufDownloadTask;
    },
  };

  const store = ggufDownloads({
    storage,
    inspect: async path => {
      inspected.push(path);
      const read = options.inspection ?? (async () => ({ contextWindow: 4096, tools: true }));
      return read();
    },
    release: async fileId => {
      released.push(fileId);
    },
  });
  return { store, files, index, tasks, inspected, released };
}

const MODEL = {
  fileId: 'small',
  name: 'Small model',
  url: 'https://example.com/small.gguf',
  sizeBytes: 1000,
  sha256: 'a'.repeat(64),
  license: 'Apache 2.0',
};

const CATALOG = { kind: 'catalog', model: MODEL } as const;

/** Lets every promise the store is holding run to its next await. */
async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Progress, then the terminal result, with the store's promise chain drained. */
async function finish(task: Task, bytes: number) {
  task.progress({ bytesWritten: bytes, totalBytes: bytes });
  task.settle({ uri: `/tmp/${task.name}` });
  await flush();
}

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
  it('drops an entry whose file is gone and a partial file a previous run left', () => {
    const h = harness();
    const saved: GgufModelRecord = {
      fileId: 'gone',
      name: 'Gone',
      url: 'https://example.com/g.gguf',
      sizeBytes: 10,
      contextWindow: 4096,
      tools: false,
    };
    h.index.text = JSON.stringify([saved, { ...saved, fileId: 'here' }]);
    h.files.set(ggufModelName('here'), 10);
    h.files.set(ggufPartialName('old'), 5);
    h.store.load();
    expect(h.store.snapshot().models.map(model => model.fileId)).toEqual(['here']);
    expect(h.files.has(ggufPartialName('old'))).toBe(false);
  });

  it('reads nothing out of an index it cannot parse', () => {
    const h = harness();
    h.index.text = '{ not json';
    h.store.load();
    expect(h.store.snapshot().models).toEqual([]);
  });
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
