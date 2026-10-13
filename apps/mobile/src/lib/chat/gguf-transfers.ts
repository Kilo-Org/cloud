import {
  type GgufDownload,
  type GgufDownloadSource,
  type GgufDownloadTask,
  type GgufInspect,
  type GgufInspection,
  ggufModelName,
  ggufPartialName,
  ggufProjectorName,
  ggufProjectorPartialName,
  type GgufStorage,
  removeQuietly,
  type Settled,
  settled,
} from './gguf-records';

/** One file of a model: the model itself, then its projector when it has one. */
export type GgufTransfer = {
  readonly url: string;
  /** Where the finished file goes once the whole model is verified. */
  readonly name: string;
  readonly part: string;
  readonly expected: number | undefined;
  /** The published SHA-256; a direct link has none. */
  readonly sha256: string | undefined;
};

/** The download in progress, as the store drives it. */
export type GgufActiveDownload = {
  readonly fileId: string;
  readonly name: string;
  readonly transfers: readonly GgufTransfer[];
  /** The transfer in progress. */
  step: number;
  /** Bytes of the transfers already finished. */
  done: number;
  task: GgufDownloadTask;
  phase: GgufDownload['phase'];
  /** Progress of the transfer in progress. */
  written: number;
  total: number;
  /** Why the store itself ended the task, as opposed to a network failure. */
  stop: 'cancel' | 'space' | undefined;
  /** Set while a paused download resumes; a refused resume starts once more from zero. */
  resuming: boolean;
  restarted: boolean;
};

/** A download about to run its first transfer. */
export function activeDownload(input: {
  readonly fileId: string;
  readonly name: string;
  readonly transfers: readonly GgufTransfer[];
  readonly task: GgufDownloadTask;
}): GgufActiveDownload {
  return {
    ...input,
    step: 0,
    done: 0,
    phase: 'downloading',
    written: 0,
    total: input.transfers[0]?.expected ?? 0,
    stop: undefined,
    resuming: false,
    restarted: false,
  };
}

/**
 * Moves every finished transfer to its model name, or none: a model without its
 * projector is not the model that was verified. False when a move failed.
 */
export function moveIntoPlace(storage: GgufStorage, transfers: readonly GgufTransfer[]): boolean {
  const moved: string[] = [];
  try {
    for (const transfer of transfers) {
      storage.move(transfer.part, transfer.name);
      moved.push(transfer.name);
    }
    return true;
  } catch {
    for (const name of moved) {
      removeQuietly(storage, name);
    }
    return false;
  }
}

export function currentTransfer(download: GgufActiveDownload): GgufTransfer {
  const transfer = download.transfers[download.step];
  if (transfer === undefined) {
    throw new Error('download step out of range');
  }
  return transfer;
}

/** The files a source downloads, in order. Only a catalog model names a projector. */
export function transfersOf(source: GgufDownloadSource, fileId: string): readonly GgufTransfer[] {
  const model = (
    url: string,
    expected: number | undefined,
    sha256: string | undefined
  ): GgufTransfer => ({
    url,
    name: ggufModelName(fileId),
    part: ggufPartialName(fileId),
    expected,
    sha256,
  });
  if (source.kind === 'url') {
    return [model(source.url, undefined, undefined)];
  }
  const { projector } = source.model;
  return [
    model(source.model.url, source.model.sizeBytes, source.model.sha256),
    ...(projector === undefined
      ? []
      : [
          {
            url: projector.url,
            name: ggufProjectorName(fileId),
            part: ggufProjectorPartialName(fileId),
            expected: projector.sizeBytes,
            sha256: projector.sha256,
          },
        ]),
  ];
}

/**
 * Every file with a published hash must hash to it before llama.cpp reads the
 * model, so a wrong file is never loaded. One file at a time bounds memory and CPU.
 */
export async function readVerified(
  storage: GgufStorage,
  inspect: GgufInspect,
  transfers: readonly GgufTransfer[]
): Promise<Settled<GgufInspection> | 'checksum'> {
  const [model, projector] = transfers;
  if (model === undefined) {
    return { ok: false };
  }
  for (const transfer of transfers) {
    if (transfer.sha256 !== undefined) {
      // eslint-disable-next-line no-await-in-loop -- files hash one after another on purpose
      const hash = await settled(storage.sha256(transfer.part));
      if (!hash.ok || hash.value !== transfer.sha256) {
        return 'checksum';
      }
    }
  }
  const projectorPath = projector === undefined ? undefined : storage.path(projector.part);
  const read = await settled(inspect(storage.path(model.part), projectorPath));
  return read;
}

/** The bytes every transfer will write, or undefined while one has no stated size. */
export function expectedBytes(transfers: readonly GgufTransfer[]): number | undefined {
  let sum = 0;
  for (const transfer of transfers) {
    if (transfer.expected === undefined) {
      return undefined;
    }
    sum += transfer.expected;
  }
  return sum;
}

/** One bar for the whole model: the finished transfers, the current one, and those to come. */
export function downloadProgress(download: GgufActiveDownload): GgufDownload {
  const later = download.transfers
    .slice(download.step + 1)
    .reduce((sum, transfer) => sum + (transfer.expected ?? 0), 0);
  return {
    fileId: download.fileId,
    name: download.name,
    phase: download.phase,
    written: download.done + download.written,
    total: download.total > 0 ? download.done + download.total + later : 0,
  };
}
