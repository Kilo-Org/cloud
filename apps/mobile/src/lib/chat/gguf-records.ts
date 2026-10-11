import { z } from 'zod';

import { type CatalogModel } from './gguf-catalog';

/** One downloaded model. Model files hold no account data, so the list is shared by every account. */
export type GgufModelRecord = {
  readonly fileId: string;
  readonly name: string;
  readonly url: string;
  /** The model file and its projector together. */
  readonly sizeBytes: number;
  readonly contextWindow: number;
  readonly tools: boolean;
  /**
   * True only when the model has a projector file and llama.cpp reported that
   * it reads images. A record saved before projectors existed reads false.
   */
  readonly vision: boolean;
};

/** A downloaded model as the inference client needs it. */
export type GgufModelFile = {
  readonly path: string;
  /** The `n_ctx` the context is created with, which is also the model's window. */
  readonly contextWindow: number;
  /** True only when the model's own chat template was verified to render tools. */
  readonly tools: boolean;
  /** The vision projector, present only for a model verified to read images. */
  readonly projector: string | undefined;
};

/** The download in progress. One runs at a time, so storage is checked against one model. */
export type GgufDownload = {
  readonly fileId: string;
  readonly name: string;
  readonly phase: 'downloading' | 'paused' | 'verifying';
  /** The model file and its projector together, so one bar covers both. */
  readonly written: number;
  /** Zero until the server states a length. */
  readonly total: number;
};

export type GgufDownloadProblem = 'space' | 'network' | 'invalidFile';

export type GgufDownloadsSnapshot = {
  readonly models: readonly GgufModelRecord[];
  readonly download: GgufDownload | null;
  readonly failure: { readonly fileId: string; readonly problem: GgufDownloadProblem } | null;
};

/** The file a finished download wrote. Nothing here reads it; it only has to exist. */
export type GgufDownloadedFile = { readonly uri: string };

export type GgufDownloadTask = {
  /** Resolves null when paused, and rejects when cancelled or failed. */
  readonly downloadAsync: () => Promise<GgufDownloadedFile | null>;
  readonly resumeAsync: () => Promise<GgufDownloadedFile | null>;
  readonly pause: () => void;
  readonly cancel: () => void;
};

/** The file system as the store uses it. Names are relative to the models directory. */
export type GgufStorage = {
  readonly freeBytes: () => number;
  readonly list: () => readonly string[];
  readonly size: (name: string) => number;
  readonly remove: (name: string) => void;
  readonly move: (from: string, to: string) => void;
  readonly path: (name: string) => string;
  readonly readIndex: () => string | null;
  readonly writeIndex: (text: string) => void;
  readonly createDownload: (
    url: string,
    name: string,
    onProgress: (progress: { readonly bytesWritten: number; readonly totalBytes: number }) => void
  ) => GgufDownloadTask;
};

/** What a model's own files say about it, read before the model is offered. */
export type GgufInspection = {
  readonly contextWindow: number;
  readonly tools: boolean;
  /** False without a projector. */
  readonly vision: boolean;
};

/** Throws for a file llama.cpp cannot load, and for a projector it cannot load with the model. */
export type GgufInspect = (path: string, projector: string | undefined) => Promise<GgufInspection>;

export type GgufDownloadSource =
  | { readonly kind: 'catalog'; readonly model: CatalogModel }
  | { readonly kind: 'url'; readonly fileId: string; readonly name: string; readonly url: string };

export type Settled<T> = { readonly ok: true; readonly value: T } | { readonly ok: false };

/**
 * Awaits a native call whose failure is never shown: llama.cpp reports through
 * thrown errors that carry raw text, and every caller decides from the flag.
 */
export async function settled<T>(operation: Promise<T>): Promise<Settled<T>> {
  try {
    return { ok: true, value: await operation };
  } catch {
    return { ok: false };
  }
}

/**
 * Room left free after a model lands, so a download never fills the device.
 * Checked before a download starts, or as soon as the server states a length.
 */
export const STORAGE_HEADROOM_BYTES = 512 * 1024 * 1024;

export const ggufModelName = (fileId: string) => `${fileId}.gguf`;

/** A partial download is never resumed across launches, so its name is not a model's. */
export const ggufPartialName = (fileId: string) => `${fileId}.gguf.part`;

/** The vision projector (mmproj) that belongs to a model. */
export const ggufProjectorName = (fileId: string) => `${fileId}.mmproj.gguf`;

export const ggufProjectorPartialName = (fileId: string) => `${fileId}.mmproj.gguf.part`;

const modelRecord = z.object({
  fileId: z.string().min(1),
  name: z.string(),
  url: z.string(),
  sizeBytes: z.number(),
  contextWindow: z.number().positive(),
  tools: z.boolean(),
  // Saved before projectors existed: the model reads text only.
  vision: z.boolean().default(false),
});

/** The files a record keeps on the device. */
export const recordFileNames = (record: GgufModelRecord) => [
  ggufModelName(record.fileId),
  ...(record.vision ? [ggufProjectorName(record.fileId)] : []),
];

/** The files the inference client loads for a downloaded model. */
export function modelFileOf(storage: GgufStorage, record: GgufModelRecord): GgufModelFile {
  return {
    path: storage.path(ggufModelName(record.fileId)),
    contextWindow: record.contextWindow,
    tools: record.tools,
    projector: record.vision ? storage.path(ggufProjectorName(record.fileId)) : undefined,
  };
}

/** Deletes a file that may never have been written, or may already be gone. */
export function removeQuietly(storage: GgufStorage, name: string): void {
  try {
    storage.remove(name);
  } catch {
    // Nothing to delete.
  }
}

/**
 * The saved list, which is file input: an entry this build cannot read is
 * dropped and the others are kept. Dropping all of them would delete every
 * downloaded model on the next cleanup, which no user action can undo.
 */
export function readModelIndex(text: string | null): readonly GgufModelRecord[] {
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text ?? '[]');
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) {
    return [];
  }
  const records: GgufModelRecord[] = [];
  for (const entry of parsed) {
    const record = modelRecord.safeParse(entry);
    if (record.success) {
      records.push(record.data);
    }
  }
  return records;
}

/**
 * Whether the saved list could be read at all. A list that cannot be read is
 * not evidence that nothing is downloaded, so cleanup must not run on it.
 */
export function modelIndexIsReadable(text: string | null): boolean {
  try {
    return Array.isArray(JSON.parse(text ?? '[]'));
  } catch {
    return false;
  }
}

/** Reads only the field that names a file, so an entry of another shape still protects it. */
const mentionedRecord = z.object({ fileId: z.string().min(1) }).loose();

/**
 * Every model and projector file the saved list names, read without trusting
 * its shape.
 *
 * An entry this build cannot parse is still an entry that describes a
 * downloaded model, so its files are protected from cleanup. Reading the list
 * strictly and then deleting whatever it does not name would destroy downloads
 * the moment a record shape changed.
 */
export function modelIndexMentionedNames(text: string | null): ReadonlySet<string> {
  const names = new Set<string>();
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text ?? '[]');
  } catch {
    return names;
  }
  if (!Array.isArray(parsed)) {
    return names;
  }
  for (const entry of parsed) {
    const record = mentionedRecord.safeParse(entry);
    if (record.success) {
      names.add(ggufModelName(record.data.fileId));
      names.add(ggufProjectorName(record.data.fileId));
    }
  }
  return names;
}

/**
 * Whether the saved list parsed in full, entry by entry.
 *
 * Only then is writing it back lossless. A list that does not parse, or that
 * holds an entry this build cannot read, is left as it is: rewriting it would
 * drop that entry, and the next launch would then delete the file it names.
 */
export function modelIndexFullyParsed(text: string | null): boolean {
  let parsed: unknown = undefined;
  try {
    parsed = JSON.parse(text ?? '[]');
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) {
    return false;
  }
  return parsed.every(entry => modelRecord.safeParse(entry).success);
}

/**
 * The model files cleanup may delete: the ones the saved list never names.
 *
 * A list that could not be read is not a list of nothing, so it deletes
 * nothing. Neither does an entry this build cannot parse delete its own file,
 * because a shape change would otherwise destroy every download at once.
 */
export function orphanedModelFiles(input: {
  readonly names: readonly string[];
  readonly index: string | null;
  readonly kept: readonly GgufModelRecord[];
  /** The partial files of the download in progress, which survive the cleanup. */
  readonly partialNames: readonly string[];
}): readonly string[] {
  const { names, index, kept, partialNames } = input;
  if (!modelIndexIsReadable(index)) {
    return [];
  }
  const keep = new Set([...kept.flatMap(record => recordFileNames(record)), ...partialNames]);
  const mentioned = modelIndexMentionedNames(index);
  return names.filter(name => name.includes('.gguf') && !keep.has(name) && !mentioned.has(name));
}
