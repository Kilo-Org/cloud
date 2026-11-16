import { describe, expect, it, vi } from 'vitest';

import { ggufModelLocator, ggufModelOptions } from './gguf-models';

const fsMock = vi.hoisted(() => ({
  readIndexFails: true,
  readIndexAttempts: 0,
  files: new Map<string, number>([
    ['models.json', 0],
    ['small.gguf', 10],
  ]),
  indexText: JSON.stringify([
    {
      fileId: 'small',
      name: 'Small model',
      url: 'https://example.com/small.gguf',
      sizeBytes: 10,
      contextWindow: 4096,
      tools: false,
      vision: false,
      thinking: false,
    },
  ]),
}));

const appState = vi.hoisted(() => ({ addEventListener: vi.fn(() => ({ remove: vi.fn() })) }));

vi.mock('react-native', () => ({
  AppState: { addEventListener: appState.addEventListener },
  Platform: { OS: 'android' },
}));

vi.mock('expo', () => ({
  requireNativeModule: () => ({ sha256File: () => Promise.resolve('a'.repeat(64)) }),
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: () => Promise.resolve('digest'),
}));

vi.mock('llama.rn', () => ({ initLlama: vi.fn() }));

// The document directory the store writes into, in memory. `models.json` exists so
// the index read is attempted, and it throws until the retry the picker offers.
// `new File(...)` returns the object, so a factory function stands in for the class.
vi.mock('expo-file-system', () => {
  function MockDirectory() {
    return {
      exists: true,
      create: () => undefined,
      list: () => [...fsMock.files.keys()].map(name => ({ name })),
    };
  }
  function MockFile(_directory: unknown, name: string) {
    return {
      get exists() {
        return fsMock.files.has(name);
      },
      get size() {
        return fsMock.files.get(name) ?? 0;
      },
      get uri() {
        return `/documents/gguf-models/${name}`;
      },
      delete: () => {
        fsMock.files.delete(name);
      },
      // The store only moves a finished transfer onto the model's file.
      moveSync: () => undefined,
      textSync: () => {
        fsMock.readIndexAttempts += 1;
        if (fsMock.readIndexFails) {
          throw new Error('storage unavailable');
        }
        return fsMock.indexText;
      },
      // The parsed list is written back; the test asserts the model, not the file.
      writeSync: () => undefined,
    };
  }
  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { document: '/documents', availableDiskSpace: 8_000_000_000 },
  };
});

describe('the GGUF store bootstrap', () => {
  it('installs the background listener and retries the read only on retryLoad', async () => {
    // The module reads the index as it loads, so the test imports it after its own
    // mocks are in place and drives the one instance this file owns.
    const { ggufDownloadActions, ggufModelProvider } = await import('./gguf-models');

    await expect(ggufModelProvider.availability()).resolves.toMatchObject({
      status: 'unavailable',
      reason: 'model_unavailable',
    });
    expect(fsMock.readIndexAttempts).toBe(1);
    expect(appState.addEventListener).not.toHaveBeenCalled();

    // The rendering read path never re-attempts a failure it already reported.
    await expect(ggufModelProvider.availability()).resolves.toMatchObject({
      status: 'unavailable',
    });
    expect(fsMock.readIndexAttempts).toBe(1);

    fsMock.readIndexFails = false;
    ggufDownloadActions.retryLoad();

    await expect(ggufModelProvider.availability()).resolves.toMatchObject({ status: 'available' });
    expect(appState.addEventListener).toHaveBeenCalledTimes(1);
    expect(ggufModelProvider.facts('small')).toMatchObject({ contextWindow: 4096 });
  });
});

describe('the GGUF model locator', () => {
  it('names the repository of a Hugging Face resolve link', () => {
    expect(
      ggufModelLocator(
        'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen2.5-0.5b-instruct-q8_0.gguf'
      )
    ).toBe('Qwen/Qwen2.5-0.5B-Instruct-GGUF');
  });

  it('names the host when a Hugging Face link has no repository', () => {
    expect(ggufModelLocator('https://huggingface.co/models')).toBe('huggingface.co');
    expect(ggufModelLocator('https://huggingface.co')).toBe('huggingface.co');
  });

  it('names the host of any other link', () => {
    expect(ggufModelLocator('https://example.com/models/tiny.gguf')).toBe('example.com');
  });

  it('names nothing for a value that is not a URL', () => {
    expect(ggufModelLocator('not a url')).toBe('');
  });

  it('decodes a percent-encoded segment and keeps a segment it cannot decode', () => {
    expect(
      ggufModelLocator('https://huggingface.co/Qwen%20AI/model-GGUF/resolve/main/x.gguf')
    ).toBe('Qwen AI/model-GGUF');
    expect(ggufModelLocator('https://huggingface.co/Qwen%2/model-GGUF')).toBe('Qwen%2/model-GGUF');
  });
});

describe('GGUF model options', () => {
  it('subtitles each model with its source and keys it by its file id', () => {
    const options = ggufModelOptions([
      {
        fileId: 'hf-0123456789abcdef',
        name: 'Qwen2.5 0.5B Instruct',
        url: 'https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF/resolve/main/qwen.gguf',
        sizeBytes: 10,
        contextWindow: 4096,
        tools: false,
        vision: false,
        thinking: false,
      },
      {
        fileId: 'url-fedcba9876543210',
        name: 'Tiny model',
        url: 'https://example.com/models/tiny.gguf',
        sizeBytes: 10,
        contextWindow: 2048,
        tools: false,
        vision: false,
        thinking: false,
      },
    ]);

    expect(options.map(option => option.displayId)).toStrictEqual([
      'Qwen/Qwen2.5-0.5B-Instruct-GGUF',
      'example.com',
    ]);
    expect(options.map(option => option.id)).toStrictEqual([
      'local:gguf:hf-0123456789abcdef',
      'local:gguf:url-fedcba9876543210',
    ]);
  });
});
