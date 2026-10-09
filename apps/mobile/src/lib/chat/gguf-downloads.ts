import {
  type GgufDownload,
  type GgufDownloadProblem,
  type GgufDownloadSource,
  type GgufDownloadsSnapshot,
  type GgufDownloadTask,
  type GgufInspect,
  ggufModelName,
  type GgufModelRecord,
  ggufPartialName,
  type GgufStorage,
  modelIndexHasUnreadableEntries,
  orphanedModelFiles,
  readModelIndex,
  settled,
  STORAGE_HEADROOM_BYTES,
} from './gguf-records';

type Active = {
  readonly fileId: string;
  readonly name: string;
  readonly url: string;
  readonly expected: number | undefined;
  task: GgufDownloadTask;
  phase: GgufDownload['phase'];
  written: number;
  total: number;
  /** Why the store itself ended the task, as opposed to a network failure. */
  stop: 'cancel' | 'space' | undefined;
  /** Set while a paused download resumes; a refused resume starts once more from zero. */
  resuming: boolean;
  restarted: boolean;
};

/**
 * Downloaded GGUF models and the one download in progress. A download the
 * person starts can pause, resume, or cancel. Every failure and every cancel
 * removes the partial file, and a partial file left by a previous run goes on
 * load, so storage only ever holds whole, verified models.
 */
export function ggufDownloads({
  storage,
  inspect,
  release,
}: {
  readonly storage: GgufStorage;
  readonly inspect: GgufInspect;
  /** Frees a model's loaded context before its file is deleted. */
  readonly release: (fileId: string) => Promise<void>;
}) {
  let models: readonly GgufModelRecord[] = [];
  let active: Active | undefined = undefined;
  let failure: GgufDownloadsSnapshot['failure'] = null;
  let snapshot: GgufDownloadsSnapshot = { models, download: null, failure };
  const listeners = new Set<() => void>();

  const publish = () => {
    snapshot = {
      models,
      download:
        active === undefined
          ? null
          : {
              fileId: active.fileId,
              name: active.name,
              phase: active.phase,
              written: active.written,
              total: active.total,
            },
      failure,
    };
    for (const listener of listeners) {
      listener();
    }
  };

  const save = (next: readonly GgufModelRecord[]) => {
    models = next;
    storage.writeIndex(JSON.stringify(next));
  };

  const discard = (download: Active) => {
    try {
      storage.remove(ggufPartialName(download.fileId));
    } catch {
      // Nothing was written yet, or the partial file is already gone.
    }
    if (active === download) {
      active = undefined;
    }
  };

  const fail = (download: Active, problem: GgufDownloadProblem) => {
    discard(download);
    failure = { fileId: download.fileId, problem };
    publish();
  };

  const complete = async (download: Active) => {
    download.phase = 'verifying';
    publish();
    const part = ggufPartialName(download.fileId);
    const size = storage.size(part);
    const expected = download.expected ?? (download.total > 0 ? download.total : undefined);
    if (size === 0 || (expected !== undefined && size !== expected)) {
      fail(download, download.expected === undefined ? 'network' : 'invalidFile');
      return;
    }
    // A whole, sized file is not yet a model: llama.cpp has to read it.
    const read = await settled(inspect(storage.path(part)));
    if (active !== download) {
      return;
    }
    if (!read.ok) {
      fail(download, 'invalidFile');
      return;
    }
    try {
      storage.move(part, ggufModelName(download.fileId));
    } catch {
      fail(download, 'invalidFile');
      return;
    }
    active = undefined;
    save([
      ...models,
      {
        fileId: download.fileId,
        name: download.name,
        url: download.url,
        sizeBytes: size,
        contextWindow: read.value.contextWindow,
        tools: read.value.tools,
      },
    ]);
    publish();
  };

  const onProgress =
    (download: () => Active | undefined) =>
    (progress: { readonly bytesWritten: number; readonly totalBytes: number }) => {
      const current = download();
      if (current === undefined || active !== current || current.phase !== 'downloading') {
        return;
      }
      // Bytes arriving after a resume mean the server accepted it.
      current.resuming = false;
      const firstLength = current.total <= 0 && progress.totalBytes > 0;
      current.written = progress.bytesWritten;
      current.total = progress.totalBytes > 0 ? progress.totalBytes : (current.expected ?? 0);
      const room = storage.freeBytes();
      if (
        firstLength &&
        current.expected === undefined &&
        room < current.total - current.written + STORAGE_HEADROOM_BYTES
      ) {
        current.stop = 'space';
        current.task.cancel();
        return;
      }
      publish();
    };

  /** A resume the server refused: drop the partial file and download it again from zero. */
  const restart = (download: Active) => {
    try {
      storage.remove(ggufPartialName(download.fileId));
    } catch {
      // The refused resume left nothing behind.
    }
    download.resuming = false;
    download.restarted = true;
    download.written = 0;
    download.total = 0;
    download.task = storage.createDownload(
      download.url,
      ggufPartialName(download.fileId),
      onProgress(() => download)
    );
    publish();
    void settle(download, download.task.downloadAsync());
  };

  const settle = async (download: Active, operation: Promise<unknown>) => {
    const outcome = await settled(operation);
    if (active !== download) {
      return;
    }
    if (!outcome.ok) {
      if (download.stop === 'cancel') {
        discard(download);
        publish();
      } else if (download.stop === 'space') {
        fail(download, 'space');
      } else if (download.resuming && !download.restarted) {
        restart(download);
      } else {
        fail(download, 'network');
      }
      return;
    }
    if (outcome.value === null) {
      download.phase = 'paused';
      publish();
      return;
    }
    await complete(download);
  };

  return {
    load: () => {
      const names = storage.list();
      const index = storage.readIndex();
      const kept = readModelIndex(index).filter(model =>
        names.includes(ggufModelName(model.fileId))
      );
      const partial = active === undefined ? undefined : ggufPartialName(active.fileId);
      for (const name of orphanedModelFiles({ names, index, kept, partialName: partial })) {
        storage.remove(name);
      }
      models = kept;
      // Rewriting a list with an entry this build cannot read would drop that
      // entry, and the next launch would then delete the file it names.
      if (!modelIndexHasUnreadableEntries(index)) {
        save(kept);
      }
      publish();
    },
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    model: (fileId: string) => models.find(model => model.fileId === fileId),
    modelPath: (fileId: string) => storage.path(ggufModelName(fileId)),
    start: (source: GgufDownloadSource) => {
      const fileId = source.kind === 'catalog' ? source.model.fileId : source.fileId;
      if (active !== undefined || models.some(model => model.fileId === fileId)) {
        return false;
      }
      const expected = source.kind === 'catalog' ? source.model.sizeBytes : undefined;
      failure = null;
      if (expected !== undefined && storage.freeBytes() < expected + STORAGE_HEADROOM_BYTES) {
        failure = { fileId, problem: 'space' };
        publish();
        return false;
      }
      const url = source.kind === 'catalog' ? source.model.url : source.url;
      const name = source.kind === 'catalog' ? source.model.name : source.name;
      try {
        storage.remove(ggufPartialName(fileId));
      } catch {
        // No partial file from an earlier attempt.
      }
      let download: Active | undefined = undefined;
      const task = storage.createDownload(
        url,
        ggufPartialName(fileId),
        onProgress(() => download)
      );
      download = {
        fileId,
        name,
        url,
        expected,
        task,
        phase: 'downloading',
        written: 0,
        total: expected ?? 0,
        stop: undefined,
        resuming: false,
        restarted: false,
      };
      active = download;
      publish();
      void settle(download, task.downloadAsync());
      return true;
    },
    pause: (fileId: string) => {
      const download = active;
      if (download?.fileId === fileId && download.phase === 'downloading') {
        download.task.pause();
      }
    },
    resume: (fileId: string) => {
      const download = active;
      if (download?.fileId !== fileId || download.phase !== 'paused') {
        return;
      }
      download.phase = 'downloading';
      download.resuming = true;
      publish();
      void settle(download, download.task.resumeAsync());
    },
    cancel: (fileId: string) => {
      const download = active;
      if (download?.fileId !== fileId || download.phase === 'verifying') {
        return;
      }
      download.stop = 'cancel';
      download.task.cancel();
      if (download.phase === 'paused') {
        // A paused task has no pending promise left to reject.
        discard(download);
        publish();
      }
    },
    dismissFailure: () => {
      failure = null;
      publish();
    },
    remove: async (fileId: string) => {
      if (!models.some(model => model.fileId === fileId)) {
        return;
      }
      await release(fileId);
      try {
        storage.remove(ggufModelName(fileId));
      } catch {
        // Already gone; the list entry still goes.
      }
      save(models.filter(model => model.fileId !== fileId));
      publish();
    },
  };
}
