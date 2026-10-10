import { type ModelClientService, type ModelRequest } from '@kilocode/harness-sdk';
import { Effect, Either, Schedule, Stream } from 'effect';
import { type TFunction } from 'i18next';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { modelDownload } from './android-model-download';
import { localModelOptions } from './backend-model-options';
import { IMAGE_OMITTED, routedModelClient } from './backend-routing';
import { backendFailureKey } from './backend-target';
import { localModelProvider, type LocalModelStatus } from './local-models';
import { type NativeAvailability, type NativeModelEvent } from './native-model-client';
import { IMAGE_NOT_SENT } from './native-request';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));
vi.mock('./backend-store', () => ({ listChatBackends: () => [] }));
// The registry loads the GGUF provider, whose module scope reaches native code.
vi.mock('./gguf-models', () => ({ ggufModelProvider: undefined }));
vi.mock('react-native', () => ({ Platform: { OS: 'android' } }));

type DownloadEvent = {
  readonly status: 'downloading' | 'available' | 'error';
  readonly bytesDownloaded?: number;
  readonly bytesToDownload?: number;
};

const android = vi.hoisted(() => {
  const listeners = new Set<(event: NativeModelEvent) => void>();
  const available: NativeAvailability = {
    status: 'available',
    modelId: 'gemini-nano',
    contextWindow: 4000,
    maxOutputTokens: 4096,
    systemInstructions: false,
  };
  return {
    available,
    availability: vi.fn<() => Promise<NativeAvailability>>(),
    generate: vi.fn(async (request: { id: string }) => {
      await Promise.resolve();
      for (const listener of listeners) {
        listener({ id: request.id, kind: 'delta', text: 'Nano' });
        listener({ id: request.id, kind: 'done', stop: 'end', usageSource: 'counted' });
      }
    }),
    cancel: vi.fn<(id: string) => Promise<void>>().mockResolvedValue(undefined),
    countTokens: vi.fn<() => Promise<number>>().mockResolvedValue(5),
    download: vi.fn<() => Promise<null>>().mockResolvedValue(null),
    addListener: (name: string, listener: (event: NativeModelEvent) => void) => {
      if (name === 'onModelEvent') {
        listeners.add(listener);
      }
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
  };
});

vi.mock('expo', () => ({
  requireOptionalNativeModule: (name: string) => (name === 'KiloAndroidModel' ? android : null),
}));

beforeEach(() => {
  android.availability.mockReset().mockResolvedValue(android.available);
  android.generate.mockClear();
});

const t = ((key: string) => key) as TFunction;

const statusWith = (availability: NativeAvailability): LocalModelStatus => ({
  provider: 'android',
  targetId: 'local:android',
  nameKey: 'modelChat.localModels.android',
  availability,
});

const question: ModelRequest = {
  model: 'local:android',
  maxTokens: 512,
  tools: [],
  prompt: {
    system: [{ text: 'System', cache: false }],
    messages: [{ role: 'user', cache: false, parts: [{ kind: 'text', text: 'Question' }] }],
  },
};

function router() {
  const kilo = vi.fn<ModelClientService['stream']>(() => Stream.empty);
  const client = routedModelClient({
    kilo: { stream: kilo },
    retry: { schedule: Schedule.recurs(0) },
    profiles: () => [],
    fetch: vi.fn(),
    headers: () => ({}),
    validateTransport: () => undefined,
  });
  return { client, kilo };
}

describe('Android Gemini Nano', () => {
  it('offers Gemini Nano only while the system reports it available', () => {
    expect(localModelOptions([statusWith(android.available)], t)).toMatchObject([
      { id: 'local:android', name: 'modelChat.localModels.android', displayId: 'gemini-nano' },
    ]);
    for (const status of ['downloadable', 'downloading', 'unavailable'] as const) {
      expect(localModelOptions([statusWith({ ...android.available, status })], t)).toEqual([]);
    }
  });

  it('routes local:android to the Android module', async () => {
    const { client, kilo } = router();
    const events = await Effect.runPromise(Stream.runCollect(client.stream(question)));
    expect([...events][0]).toEqual({ kind: 'delta', text: 'Nano' });
    expect(android.generate).toHaveBeenCalledOnce();
    expect(kilo).not.toHaveBeenCalled();
    expect(localModelProvider('android')?.supportsTools('system')).toBe(false);
  });

  it.each(['downloadable', 'downloading'] as const)(
    'fails explicitly without Kilo or a download while the model is %s',
    async status => {
      android.availability.mockResolvedValue({ ...android.available, status });
      const { client, kilo } = router();
      const result = await Effect.runPromise(
        Effect.either(Stream.runCollect(client.stream(question)))
      );
      expect(Either.isLeft(result) && backendFailureKey(result.left)).toBe(
        'modelChat.localModels.unavailable'
      );
      expect(android.generate).not.toHaveBeenCalled();
      expect(android.download).not.toHaveBeenCalled();
      expect(kilo).not.toHaveBeenCalled();
    }
  );

  it('sends an image only after the device model reports that it reads images', async () => {
    const withImages: ModelRequest = {
      ...question,
      prompt: {
        ...question.prompt,
        messages: [
          {
            role: 'user',
            cache: false,
            parts: [
              { kind: 'image', media: 'image/jpeg', data: 'T2xk' },
              { kind: 'text', text: 'Before' },
            ],
          },
          { role: 'assistant', cache: false, parts: [{ kind: 'text', text: 'Seen.' }] },
          {
            role: 'user',
            cache: false,
            parts: [
              { kind: 'image', media: 'image/jpeg', data: 'TmV3' },
              { kind: 'text', text: 'And this?' },
            ],
          },
        ],
      },
    };
    const provider = localModelProvider('android');
    const { client } = router();

    await provider?.availability();
    expect(provider?.supportsImages('system')).toBe(false);
    await Effect.runPromise(Stream.runCollect(client.stream(withImages)));
    expect(android.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', text: `${IMAGE_OMITTED}\n\nBefore` },
          { role: 'assistant', text: 'Seen.' },
          { role: 'user', text: `${IMAGE_OMITTED}\n\nAnd this?` },
        ],
      })
    );

    android.availability.mockResolvedValue({ ...android.available, images: true, maxImages: 1 });
    await provider?.availability();
    expect(provider?.supportsImages('system')).toBe(true);
    await Effect.runPromise(Stream.runCollect(client.stream(withImages)));
    expect(android.generate).toHaveBeenLastCalledWith(
      expect.objectContaining({
        messages: [
          { role: 'user', text: `${IMAGE_NOT_SENT}\n\nBefore` },
          { role: 'assistant', text: 'Seen.' },
          { role: 'user', text: 'And this?', images: [{ media: 'image/jpeg', data: 'TmV3' }] },
        ],
      })
    );
  });
});

function fakeDownload() {
  const listeners = new Set<(event: DownloadEvent) => void>();
  const finish = Promise.withResolvers<undefined>();
  const bridge = {
    download: vi.fn(async () => {
      await finish.promise;
    }),
    addListener: (_name: 'onModelDownload', listener: (event: DownloadEvent) => void) => {
      listeners.add(listener);
      return {
        remove: () => {
          listeners.delete(listener);
        },
      };
    },
  };
  const emit = (event: DownloadEvent) => {
    for (const listener of listeners) {
      listener(event);
    }
  };
  return { bridge, emit, finish, listeners };
}

describe('Android model download', () => {
  it('starts only when asked, reports progress, and refreshes the status after completion', async () => {
    const { bridge, emit, finish, listeners } = fakeDownload();
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const download = modelDownload(bridge, refresh);
    expect(bridge.download).not.toHaveBeenCalled();
    expect(download.current()).toEqual({ kind: 'idle' });

    const done = download.start();
    // A second tap while it runs does not start another download.
    void download.start();
    expect(bridge.download).toHaveBeenCalledOnce();
    expect(download.current()).toEqual({ kind: 'downloading' });

    emit({ status: 'downloading', bytesDownloaded: 0, bytesToDownload: 400 });
    emit({ status: 'downloading', bytesDownloaded: 100 });
    expect(download.current()).toEqual({
      kind: 'downloading',
      bytesDownloaded: 100,
      bytesToDownload: 400,
    });

    finish.resolve(undefined);
    await done;
    expect(refresh).toHaveBeenCalledOnce();
    expect(download.current()).toEqual({ kind: 'idle' });
    expect(listeners.size).toBe(0);
  });

  it('reports a failed download and still refreshes the status', async () => {
    const { bridge, finish } = fakeDownload();
    const refresh = vi.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const download = modelDownload(bridge, refresh);
    const seen: string[] = [];
    download.subscribe(() => {
      seen.push(download.current().kind);
    });
    const done = download.start();
    finish.reject(
      Object.assign(new Error('insufficient_storage'), { code: 'insufficient_storage' })
    );
    await done;
    expect(seen).toEqual(['downloading', 'failed']);
    expect(refresh).toHaveBeenCalledOnce();
  });

  it('never starts the system download on its own', () => {
    expect(android.download).not.toHaveBeenCalled();
  });
});
