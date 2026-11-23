// A saved list that exists but cannot be read is not an empty library. The
// provider's answer has to say the check failed, and the retry has to clear it.
// The store latches after its first successful load, so this file owns its own
// module instance instead of borrowing the one `gguf-models.test.ts` loaded.
import { describe, expect, it, vi } from 'vitest';

const fsMock = vi.hoisted(() => ({
  files: new Map<string, number>([
    ['models.json', 0],
    ['small.gguf', 10],
  ]),
  indexText: '{ not json',
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

// The document directory the store writes into, in memory: `models.json` holds
// text `JSON.parse` rejects until the picker's retry runs after a repair.
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
      moveSync: () => undefined,
      textSync: () => fsMock.indexText,
      writeSync: () => undefined,
    };
  }
  return {
    Directory: MockDirectory,
    File: MockFile,
    Paths: { document: '/documents', availableDiskSpace: 8_000_000_000 },
  };
});

describe('a saved model list that cannot be read', () => {
  it('answers models_unreadable and clears it on the picker retry', async () => {
    const { ggufDownloadActions, ggufModelProvider } = await import('./gguf-models');

    // The empty list a failed read publishes is not an empty library, so the
    // reason names the failed check rather than a missing model.
    await expect(ggufModelProvider.availability()).resolves.toEqual({
      status: 'unavailable',
      reason: 'models_unreadable',
      modelId: '',
      contextWindow: 0,
      maxOutputTokens: 0,
      systemInstructions: true,
    });
    // A failed read installs neither the latch nor the listener.
    expect(appState.addEventListener).not.toHaveBeenCalled();

    fsMock.indexText = JSON.stringify([
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
    ]);
    ggufDownloadActions.retryLoad();

    await expect(ggufModelProvider.availability()).resolves.toMatchObject({ status: 'available' });
    expect(appState.addEventListener).toHaveBeenCalledTimes(1);
  });
});
