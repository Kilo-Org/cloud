import {
  type GgufDownloadProblem,
  type GgufDownloadSource,
  type GgufDownloadsSnapshot,
  type GgufInspect,
  type GgufModelFile,
  type GgufModelRecord,
  type GgufStorage,
  keepStoredModels,
  modelFileOf,
  modelIndexFullyParsed,
  recordFileNames,
  removeQuietly,
  settled,
  STORAGE_HEADROOM_BYTES,
} from './gguf-records';
import {
  type GgufActiveDownload as Active,
  activeDownload,
  currentTransfer,
  downloadProgress,
  expectedBytes,
  mayRetryTransfer,
  requestPause,
  requestResume,
  transferResult,
  transfersOf,
  transferStart,
} from './gguf-transfers';
import { verifyModel } from './gguf-verify';

/**
 * Downloaded GGUF models and the one download in progress. A download the
 * person starts can pause, resume, or cancel. A vision model downloads its
 * projector as part of the same download, after the model file. Every failure
 * and every cancel removes the partial files, and partial files left by a
 * previous run go on load, so storage only ever holds whole, verified models.
 *
 * Bytes a transfer never delivered, and a file this device refused, are tried
 * once more before the download is given up: missing bytes are a transfer
 * problem, and one refused read is no verdict on the file. Only a second
 * failure reports, so a download that worked is never thrown away.
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
      download: active === undefined ? null : downloadProgress(active),
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
    for (const transfer of download.transfers) {
      removeQuietly(storage, transfer.part);
      // A file the last step already moved is not in the list yet, so it goes too.
      removeQuietly(storage, transfer.name);
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

  /** Starts the transfer at the current step from zero. */
  const begin = (download: Active) => {
    const { url, part } = transferStart(download);
    const progress = onProgress(() => download);
    download.task = storage.createDownload(url, part, progress);
    publish();
    void settle(download, download.task.downloadAsync());
  };

  /** Every file is whole, sized and hashed; llama.cpp has to read them before they are a model. */
  const verify = async (download: Active, sizeBytes: number) => {
    const read = await verifyModel(storage, inspect, { ...download, sizeBytes });
    if (active !== download) {
      return;
    }
    if (!read.ok) {
      fail(download, read.problem);
      return;
    }
    active = undefined;
    save([...models, read.model]);
    publish();
  };

  /** A transfer that stopped short runs once more from zero; the second one is a network failure. */
  const again = (download: Active) => {
    if (!mayRetryTransfer(download)) {
      fail(download, 'network');
      return;
    }
    download.attempts += 1;
    removeQuietly(storage, currentTransfer(download).part);
    begin(download);
  };

  /** One transfer finished: check that it is whole, then start the next or verify the model. */
  const complete = async (download: Active) => {
    const last = download.step === download.transfers.length - 1;
    const transfer = currentTransfer(download);
    const size = storage.size(transfer.part);
    const expected = transfer.expected ?? (download.total > 0 ? download.total : undefined);
    const result = transferResult(size, expected);
    // A longer file cannot be a transfer that stopped short; a shorter one is a
    // transfer problem, and the transfer runs again before the download is failed.
    if (result !== 'whole') {
      if (result === 'long') {
        fail(download, 'invalidFile');
      } else {
        again(download);
      }
      return;
    }
    if (!last) {
      download.done += size;
      download.step += 1;
      download.restarted = false;
      download.attempts = 1;
      begin(download);
      return;
    }
    // Only a whole file is worth reading, so a retried transfer still reads as a download.
    download.phase = 'verifying';
    publish();
    await verify(download, download.done + size);
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
      const { expected } = currentTransfer(current);
      const firstLength = current.total <= 0 && progress.totalBytes > 0;
      current.written = progress.bytesWritten;
      current.total = progress.totalBytes > 0 ? progress.totalBytes : (expected ?? 0);
      const room = storage.freeBytes();
      if (
        firstLength &&
        expected === undefined &&
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
    removeQuietly(storage, currentTransfer(download).part);
    download.restarted = true;
    begin(download);
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
      // A cancel that raced the pause wins: the task reports itself paused, but
      // the person asked for the download to stop, so it does.
      if (download.stop === 'cancel') {
        discard(download);
        publish();
        return;
      }
      download.phase = 'paused';
      download.pausing = false;
      publish();
      return;
    }
    await complete(download);
  };

  return {
    load: () => {
      const index = storage.readIndex();
      models = keepStoredModels({
        storage,
        index,
        partialNames: active?.transfers.map(transfer => transfer.part) ?? [],
      });
      // Only a list that parsed in full is written back: anything else would lose
      // an entry, and the next launch would then delete the file it names.
      if (modelIndexFullyParsed(index)) {
        save(models);
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
    /** The files the inference client loads for a downloaded model. */
    file: (fileId: string): GgufModelFile | undefined => {
      const record = models.find(model => model.fileId === fileId);
      return record === undefined ? undefined : modelFileOf(storage, record);
    },
    start: (source: GgufDownloadSource) => {
      const fileId = source.kind === 'catalog' ? source.model.fileId : source.fileId;
      if (active !== undefined || models.some(model => model.fileId === fileId)) {
        return false;
      }
      const transfers = transfersOf(source, fileId);
      const expected = expectedBytes(transfers);
      failure = null;
      if (expected !== undefined && storage.freeBytes() < expected + STORAGE_HEADROOM_BYTES) {
        failure = { fileId, problem: 'space' };
        publish();
        return false;
      }
      for (const transfer of transfers) {
        // No partial file from an earlier attempt survives.
        removeQuietly(storage, transfer.part);
      }
      const [first] = transfers;
      if (first === undefined) {
        return false;
      }
      let download: Active | undefined = undefined;
      const task = storage.createDownload(
        first.url,
        first.part,
        onProgress(() => download)
      );
      download = activeDownload({
        fileId,
        name: source.kind === 'catalog' ? source.model.name : source.name,
        transfers,
        task,
      });
      active = download;
      publish();
      void settle(download, task.downloadAsync());
      return true;
    },
    pause: (fileId: string) => {
      const download = active;
      if (download?.fileId === fileId && requestPause(download)) {
        publish();
      }
    },
    resume: (fileId: string) => {
      const download = active;
      if (download?.fileId !== fileId || !requestResume(download)) {
        return;
      }
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
      const record = models.find(model => model.fileId === fileId);
      if (record === undefined) {
        return;
      }
      await release(fileId);
      // A file already gone does not keep the list entry.
      for (const name of recordFileNames(record)) {
        removeQuietly(storage, name);
      }
      save(models.filter(model => model.fileId !== fileId));
      publish();
    },
  };
}
