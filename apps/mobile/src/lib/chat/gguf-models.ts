import { CryptoDigestAlgorithm, digestStringAsync } from 'expo-crypto';
import { Directory, File, Paths } from 'expo-file-system';
import { initLlama } from 'llama.rn';
import { useSyncExternalStore } from 'react';
import { AppState, Platform } from 'react-native';

import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';

import { localTargetId } from './backend-target';
import { ggufModelClient } from './gguf-client';
import { ggufDownloads } from './gguf-downloads';
import {
  type GgufDownloadSource,
  type GgufDownloadsSnapshot,
  type GgufModelRecord,
  type GgufStorage,
} from './gguf-records';
import { contextWindowFor, templateSupportsTools } from './gguf-template';
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

const storage: GgufStorage = {
  freeBytes: () => Paths.availableDiskSpace,
  list: () => (directory.exists ? directory.list().map(entry => entry.name) : []),
  size: name => fileIn(name).size,
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
    fileIn(INDEX).write(text);
  },
  createDownload: (url, name, onProgress) =>
    File.createDownloadTask(url, fileIn(name), { onProgress }),
};

const model = ggufModelClient({
  runtime: {
    // Metal runs every layer on iOS. Android stays on the CPU: llama.rn's GPU
    // paths there are experimental and limited to some Adreno and Hexagon parts.
    init: async params => {
      const context = await initLlama({
        ...params,
        n_gpu_layers: Platform.OS === 'ios' ? 99 : 0,
      });
      return context;
    },
  },
  fileOf: fileId => {
    const record = downloads.model(fileId);
    return record === undefined
      ? undefined
      : {
          path: downloads.modelPath(fileId),
          contextWindow: record.contextWindow,
          tools: record.tools,
        };
  },
});

const downloads = ggufDownloads({
  storage,
  // Loads only the vocabulary and the template, which is enough to read both facts.
  inspect: async path => {
    const context = await initLlama({ model: path, vocab_only: true, n_ctx: 512 });
    try {
      return {
        contextWindow: contextWindowFor(context.model.metadata),
        tools: templateSupportsTools(context.model.chatTemplates),
      };
    } finally {
      await context.release();
    }
  },
  release: model.release,
});

let loaded = false;

/** The saved list is read on first use rather than at import, so startup does no file work. */
function ggufStore() {
  if (!loaded) {
    loaded = true;
    downloads.load();
    // A background app may be killed for its memory; the context loads again on the next answer.
    AppState.addEventListener('change', state => {
      if (state === 'background') {
        void model.release();
      }
    });
  }
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

export function ggufModelOptions(models: readonly GgufModelRecord[]): SessionModelOption[] {
  return models.map(record => ({
    id: localTargetId('gguf', record.fileId),
    name: record.name,
    displayId: record.fileId,
    variants: [],
    isPreferred: false,
    showGatewayMetadata: false,
    contextWindow: record.contextWindow,
  }));
}
