/* eslint-disable typescript-eslint/consistent-type-assertions, typescript-eslint/no-unsafe-argument, typescript-eslint/no-unsafe-assignment, typescript-eslint/no-unsafe-call, typescript-eslint/no-unsafe-member-access, typescript-eslint/no-unsafe-return, typescript-eslint/require-await, require-await, promise-function-async, promise/prefer-await-to-then -- a download is a pending promise: a test double can only be built by asserting its shape */
import { vi } from 'vitest';

import { ggufDownloads } from './gguf-downloads';
import {
  type GgufDownloadedFile,
  type GgufDownloadTask,
  type GgufInspection,
  type GgufStorage,
} from './gguf-records';

type Progress = (progress: { readonly bytesWritten: number; readonly totalBytes: number }) => void;

/** The task at a known position, so the assertions need no non-null assertion. */
export function taskAt(tasks: readonly Task[], index: number): Task {
  const found = tasks[index];
  if (found === undefined) {
    throw new Error(`no download task at ${index}`);
  }
  return found;
}

export type Task = {
  readonly url: string;
  readonly name: string;
  readonly progress: Progress;
  settle: (value: GgufDownloadedFile | null) => void;
  fail: () => void;
  readonly paused: ReturnType<typeof vi.fn>;
};

/** The file system and the downloads the store asked for, in memory. */
export function harness(
  options: {
    readonly freeBytes?: number;
    readonly inspection?: () => Promise<GgufInspection>;
    readonly failMove?: string;
  } = {}
) {
  const freeBytes = options.freeBytes ?? 8_000_000_000;
  const files = new Map<string, number>();
  const index: { text: string | null } = { text: null };
  const tasks: Task[] = [];
  const inspected: string[] = [];
  const released: string[] = [];
  const projectors: (string | undefined)[] = [];

  const storage: GgufStorage = {
    freeBytes: () => freeBytes,
    list: () => [...files.keys()],
    size: name => files.get(name) ?? 0,
    remove: name => {
      files.delete(name);
    },
    move: (from, to) => {
      if (to === options.failMove) {
        throw new Error('move failed');
      }
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
    inspect: async (path, projector) => {
      inspected.push(path);
      projectors.push(projector);
      const read =
        options.inspection ??
        (async () => ({ contextWindow: 4096, tools: true, vision: projector !== undefined }));
      return read();
    },
    release: async fileId => {
      released.push(fileId);
    },
  });
  return { store, files, index, tasks, inspected, projectors, released };
}

export const MODEL = {
  fileId: 'small',
  name: 'Small model',
  url: 'https://example.com/small.gguf',
  sizeBytes: 1000,
  sha256: 'a'.repeat(64),
  license: 'Apache 2.0',
};

export const CATALOG = { kind: 'catalog', model: MODEL } as const;

/** Lets every promise the store is holding run to its next await. */
export async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

/** Progress, then the terminal result, with the store's promise chain drained. */
export async function finish(task: Task, bytes: number) {
  task.progress({ bytesWritten: bytes, totalBytes: bytes });
  task.settle({ uri: `/tmp/${task.name}` });
  await flush();
}
