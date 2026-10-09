import { z } from 'zod';

import { type CatalogModel } from './gguf-catalog';

/** One downloaded model. Model files hold no account data, so the list is shared by every account. */
export type GgufModelRecord = {
  readonly fileId: string;
  readonly name: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly contextWindow: number;
  readonly tools: boolean;
};

/** A downloaded model as the inference client needs it. */
export type GgufModelFile = {
  readonly path: string;
  /** The `n_ctx` the context is created with, which is also the model's window. */
  readonly contextWindow: number;
  /** True only when the model's own chat template was verified to render tools. */
  readonly tools: boolean;
};

/** The download in progress. One runs at a time, so storage is checked against one file. */
export type GgufDownload = {
  readonly fileId: string;
  readonly name: string;
  readonly phase: 'downloading' | 'paused' | 'verifying';
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

/** What a model's own file says about it, read before the model is offered. */
export type GgufInspection = { readonly contextWindow: number; readonly tools: boolean };

/** Throws for a file llama.cpp cannot load. */
export type GgufInspect = (path: string) => Promise<GgufInspection>;

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

const modelIndex = z.array(
  z.object({
    fileId: z.string().min(1),
    name: z.string(),
    url: z.string(),
    sizeBytes: z.number(),
    contextWindow: z.number().positive(),
    tools: z.boolean(),
  })
);

/** The saved list, which is file input: an entry this build cannot read is dropped. */
export function readModelIndex(text: string | null): readonly GgufModelRecord[] {
  try {
    const parsed = modelIndex.safeParse(JSON.parse(text ?? '[]'));
    return parsed.success ? parsed.data : [];
  } catch {
    return [];
  }
}
