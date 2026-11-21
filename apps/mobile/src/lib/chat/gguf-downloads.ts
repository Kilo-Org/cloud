import {
  type GgufDownloadProblem,
  type GgufDownloadSource,
  type GgufDownloadsSnapshot,
  type GgufInspect,
  type GgufModelFile,
  type GgufModelRecord,
  type GgufStorage,
  modelFileOf,
  recordFileNames,
  removeQuietly,
  settled,
  STORAGE_HEADROOM_BYTES,
} from './gguf-records';
import { loadSavedModels, writeSavedModels } from './gguf-model-index';
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
import { createProgressReporter } from './gguf-transfer-progress';
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
  let loadFailed = false;
  let snapshot: GgufDownloadsSnapshot = { models, download: null, failure, loadFailed };
  const listeners = new Set<() => void>();

  const publish = () => {
    const download = active === undefined ? null : downloadProgress(active);
    snapshot = { models, download, failure, loadFailed };
    for (const listener of listeners) {
      listener();
    }
  };

  /**
   * Writes the list the device keeps, and only then makes it the current one:
   * a list the device could not take is not a list it holds.
   */
  const save = (next: readonly GgufModelRecord[]): boolean => {
    if (!writeSavedModels(storage, next)) {
      return false;
    }
    models = next;
    return true;
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
    download.task = storage.createDownload(
      url,
      part,
      onProgress(() => download)
    );
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
    // The record goes in before the download ends. A device that could not take
    // it holds no model the saved list names, so the files go with the failure.
    if (!save([...models, read.model])) {
      fail(download, 'space');
      return;
    }
    active = undefined;
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

  const onProgress = createProgressReporter({
    storage,
    activeDownload: () => active,
    publish,
  });

  /** A resume the server refused: drop the partial file and download it again from zero. */
  const restart = (download: Active) => {
    removeQuietly(storage, currentTransfer(download).part);
    download.restarted = true;
    begin(download);
  };

  /**
   * Publishes what the task delivered. Never rejects: its callers start it and do
   * not await it, and the row must reach a published end state either way.
   */
  const settle = async (download: Active, operation: Promise<unknown>) => {
    const outcome = await settled(operation);
    if (active !== download) {
      return;
    }
    // A stop that raced the pause wins: the task may report itself paused, but the
    // download was already meant to end. A cancel leaves no row behind, and a
    // low-space stop is the download's failure.
    const ended = !outcome.ok || outcome.value === null;
    if (ended && download.stop === 'cancel') {
      discard(download);
      publish();
      return;
    }
    if (ended && download.stop === 'space') {
      fail(download, 'space');
      return;
    }
    if (!outcome.ok) {
      if (download.resuming && !download.restarted) {
        restart(download);
      } else {
        fail(download, 'network');
      }
      return;
    }
    if (outcome.value === null) {
      download.phase = 'paused';
      download.pausing = false;
      publish();
      return;
    }
    try {
      await complete(download);
    } catch {
      // A storage call the OS refused at the last step is the download's failure,
      // not a rejection nobody awaits and a row left asking to verify.
      fail(download, 'space');
    }
  };
  return {
    load: (): boolean => {
      const saved = loadSavedModels({
        storage,
        partialNames: active?.transfers.map(transfer => transfer.part) ?? [],
      });
      // A storage the OS refused (permission, full disk, I/O) is a state the picker
      // reports, not a crash: this store is read while rendering. The list the store
      // already had stays, and a repeat of the same failure publishes nothing new.
      if (saved.failed) {
        if (!loadFailed) {
          loadFailed = true;
          publish();
        }
        return false;
      }
      models = saved.models;
      loadFailed = false;
      publish();
      return true;
    },
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    model: (fileId: string) => models.find(model => model.fileId === fileId),
    /** The file of a downloaded model, or undefined when fileId names no stored model. */
    file: (fileId: string): GgufModelFile | undefined => {
      const record = models.find(model => model.fileId === fileId);
      return record === undefined ? undefined : modelFileOf(storage, record);
    },
    start: (source: GgufDownloadSource) => {
      // A finished download writes the whole list back, so it must not run while the
      // saved one is unread: that write would drop every model it names, and the next
      // load would then delete their files.
      if (loadFailed) {
        return false;
      }
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
      // Same list, same rule: a removal rewrites the index it could not read.
      if (loadFailed) {
        return;
      }
      const record = models.find(model => model.fileId === fileId);
      if (record === undefined) {
        return;
      }
      await release(fileId);
      // A file already gone does not keep the list entry.
      for (const name of recordFileNames(record)) {
        removeQuietly(storage, name);
      }
      const remaining = models.filter(model => model.fileId !== fileId);
      if (!save(remaining)) {
        // The files are gone, so the row goes with them. The saved list still
        // names the entry, and the next load drops it and rewrites that list.
        models = remaining;
      }
      publish();
    },
  };
}
