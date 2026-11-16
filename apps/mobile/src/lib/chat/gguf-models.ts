import { requireNativeModule } from 'expo';
import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { initLlama } from 'llama.rn';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { NativeDownloadProgress } from '@/lib/native-transfer-progress';

import { localTargetId } from './backend-target';
import { ggufModelClient, loadProjector } from './gguf-client';
import { ggufDownloads } from './gguf-downloads';
import {
  type GgufDownloadSource,
  type GgufDownloadsSnapshot,
  type GgufModelRecord,
  type GgufStorage,
} from './gguf-records';
import { contextWindowFor, templateSupportsThinking, templateSupportsTools } from './gguf-template';
import { THINKING_SWITCH_VARIANTS } from './effort';
import { type LocalModelProvider } from './local-models';
import { type NativeAvailability } from './native-model-client';

const INDEX = 'models.json';

// The document directory: the system never purges it, unlike the cache.
const directory = new Directory(Paths.document, 'gguf-models');

function fileIn(name: string): File {
  if (!directory.exists) {
    directory.create({ intermediates: true });
  }
  return new File(directory, name);
}

/**
 * Neither expo-crypto nor expo-file-system hashes a file incrementally, and a
 * model is too large to read whole, so a local module streams the file through
 * the platform SHA-256 on a background thread.
 */
const fileHash = requireNativeModule<{ sha256File(uri: string): Promise<string> }>('KiloFileHash');

const storage: GgufStorage = {
  freeBytes: () => Paths.availableDiskSpace,
  list: () => (directory.exists ? directory.list().map(entry => entry.name) : []),
  size: name => fileIn(name).size,
  sha256: async name => {
    const hash = await fileHash.sha256File(fileIn(name).uri);
    return hash;
  },
  remove: name => {
    const file = fileIn(name);
    if (file.exists) {
      file.delete();
    }
  },
  move: (from, to) => {
    fileIn(from).moveSync(fileIn(to));
  },
  path: name => fileIn(name).uri,
  readIndex: () => {
    const file = fileIn(INDEX);
    return file.exists ? file.textSync() : null;
  },
  writeIndex: text => {
    fileIn(INDEX).writeSync(text);
  },
  createDownload: (url, name, onProgress) =>
    File.createDownloadTask(url, fileIn(name), {
      onProgress: progress => {
        const parsed = NativeDownloadProgress.safeParse(progress);
        if (parsed.success) {
          onProgress(parsed.data);
        }
      },
    }),
};

// Metal runs every layer on iOS. Android stays on the CPU: llama.rn's GPU
// paths there are experimental and limited to some Adreno and Hexagon parts.
const GPU = Platform.OS === 'ios';

const model = ggufModelClient({
  runtime: {
    init: async params => {
      const context = await initLlama({ ...params, n_gpu_layers: GPU ? 99 : 0 });
      return context;
    },
    gpu: GPU,
  },
  fileOf: fileId => downloads.file(fileId),
});

const downloads = ggufDownloads({
  storage,
  // The vocabulary and the template are enough for the window and the tool
  // rule. A projector checks its size against the model's weights, so a vision
  // model loads in full to prove it reads images.
  inspect: async (path, projector) => {
    const context = await initLlama({
      model: path,
      n_ctx: 512,
      ...(projector === undefined ? { vocab_only: true } : { n_gpu_layers: 0 }),
    });
    try {
      return {
        contextWindow: contextWindowFor(context.model.metadata),
        tools: templateSupportsTools(context.model.chatTemplates),
        vision: projector !== undefined && (await loadProjector(context, projector, GPU)),
        thinking: templateSupportsThinking(context.model.metadata),
      };
    } finally {
      await context.release();
    }
  },
  release: model.release,
});

let loaded = false;

/**
 * The background listener, kept on the global scope so a module reload (fast
 * refresh) removes the one the previous instance added instead of stacking a
 * second subscription that could never be torn down.
 */
const BACKGROUND_LISTENER = Symbol.for('kilo.gguf.backgroundListener');

/**
 * The saved list is read on first use rather than at import, so startup does no file work.
 *
 * The latch is set only after `load()` succeeded and the background listener is
 * installed: a read that failed must be retryable, and a listener that was never
 * installed would let a loaded llama context survive into the background. A failed
 * read is not retried from the snapshot getter — that runs while rendering — so the
 * picker's retry calls `retryLoad`.
 */
function ensureGgufStore(options: { retry?: boolean } = {}): void {
  if (loaded) {
    return;
  }
  if (downloads.snapshot().loadFailed && options.retry !== true) {
    return;
  }
  if (!downloads.load()) {
    return;
  }
  // A failed attempt installs neither the listener nor the latch, so the previous
  // instance's listener (fast refresh) stays until a successful attempt replaces it.
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'background') {
      void model.release();
    }
  });
  const previous = (globalThis as Partial<Record<symbol, { remove: () => void }>>)[
    BACKGROUND_LISTENER
  ];
  previous?.remove();
  (globalThis as Partial<Record<symbol, { remove: () => void }>>)[BACKGROUND_LISTENER] =
    subscription;
  loaded = true;
}

function ggufStore() {
  ensureGgufStore();
  return downloads;
}

const NO_LIMITS = { modelId: '', contextWindow: 0, maxOutputTokens: 0, systemInstructions: true };

/** The provider's own answer about whether anything is downloaded; limits are per model. */
// eslint-disable-next-line typescript-eslint/promise-function-async -- conflicting require-await rule
function ggufAvailability(): Promise<NativeAvailability> {
  const records = ggufStore().snapshot().models;
  return Promise.resolve(
    records.length > 0
      ? { ...NO_LIMITS, status: 'available' }
      : { ...NO_LIMITS, status: 'unavailable', reason: 'model_unavailable' }
  );
}

/** Downloaded GGUF models. Options exist only for models on the device. */
export const ggufModelProvider: LocalModelProvider = {
  availability: ggufAvailability,
  client: model.client,
  facts: fileId => {
    const record = ggufStore().model(fileId);
    // A quarter of the window for the answer leaves the rest for the history.
    return record === undefined
      ? { apiKinds: [] }
      : {
          apiKinds: [],
          contextWindow: record.contextWindow,
          maxOutputTokens: Math.floor(record.contextWindow / 4),
        };
  },
  supportsTools: fileId => ggufStore().model(fileId)?.tools ?? false,
  // True only for a model whose projector llama.cpp reported as reading images.
  supportsImages: fileId => ggufStore().model(fileId)?.vision ?? false,
};

export const ggufDownloadActions = {
  start: (source: GgufDownloadSource) => ggufStore().start(source),
  pause: (fileId: string) => {
    ggufStore().pause(fileId);
  },
  resume: (fileId: string) => {
    ggufStore().resume(fileId);
  },
  cancel: (fileId: string) => {
    ggufStore().cancel(fileId);
  },
  dismissFailure: () => {
    ggufStore().dismissFailure();
  },
  /** Read the saved list again after `snapshot.loadFailed`; the picker's retry. */
  retryLoad: () => {
    ensureGgufStore({ retry: true });
  },
  remove: async (fileId: string) => {
    await ggufStore().remove(fileId);
  },
};

/** A link names its own file: the same link is always the same model and target. */
export async function ggufUrlSource(url: string, name: string): Promise<GgufDownloadSource> {
  const digest = await digestStringAsync(CryptoDigestAlgorithm.SHA256, url);
  return { kind: 'url', fileId: `url-${digest.slice(0, 16)}`, name, url };
}

const subscribe = (listener: () => void) => ggufStore().subscribe(listener);
const current = () => ggufStore().snapshot();

export function useGgufModels(): GgufDownloadsSnapshot {
  return useSyncExternalStore(subscribe, current, current);
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Where a downloaded model came from, for the picker's subtitle: a Hugging Face
 * resolve link reads as its repository, any other link as its host. A link that
 * does not parse has no place to name, so the row shows no subtitle.
 */
export function ggufModelLocator(url: string): string {
  const parsed = parseUrl(url);
  if (parsed === null) {
    return '';
  }
  const segments = parsed.pathname.split('/').filter(segment => segment !== '');
  if (parsed.hostname === 'huggingface.co' && segments.length >= 2) {
    return segments
      .slice(0, 2)
      .map(segment => decodeSegment(segment))
      .join('/');
  }
  return parsed.hostname;
}

export function ggufModelOptions(models: readonly GgufModelRecord[]): SessionModelOption[] {
  return models.map(record => ({
    id: localTargetId('gguf', record.fileId),
    name: record.name,
    // The file id is an opaque content hash, so the subtitle names the source instead.
    displayId: ggufModelLocator(record.url),
    variants: record.thinking ? [...THINKING_SWITCH_VARIANTS] : [],
    isPreferred: false,
    showGatewayMetadata: false,
    contextWindow: record.contextWindow,
    capabilities: { tools: record.tools, images: record.vision },
  }));
}
