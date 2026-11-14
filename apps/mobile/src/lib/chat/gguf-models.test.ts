import { describe, expect, it, vi } from 'vitest';

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
  requireNativeModule: () => ({ sha256File: async () => 'a'.repeat(64) }),
}));

vi.mock('expo-crypto', () => ({
  CryptoDigestAlgorithm: { SHA256: 'SHA256' },
  digestStringAsync: async () => 'digest',
}));

vi.mock('llama.rn', () => ({ initLlama: vi.fn() }));

// The document directory the store writes into, in memory. `models.json` exists so
// the index read is attempted, and it throws until the retry the picker offers.
vi.mock('expo-file-system', () => {
  class MockDirectory {
    exists = true;
    create(): void {
      this.exists = true;
    }
    list(): { name: string }[] {
      return [...fsMock.files.keys()].map(name => ({ name }));
    }
  }
  class MockFile {
    private readonly name: string;
    constructor(_directory: MockDirectory, name: string) {
      this.name = name;
    }
    get exists(): boolean {
      return fsMock.files.has(this.name);
    }
    get size(): number {
      return fsMock.files.get(this.name) ?? 0;
    }
    get uri(): string {
      return `/documents/gguf-models/${this.name}`;
    }
    delete(): void {
      fsMock.files.delete(this.name);
    }
    moveSync(): void {
      // The store only moves a finished transfer onto the model's file.
    }
    textSync(): string {
      fsMock.readIndexAttempts += 1;
      if (fsMock.readIndexFails) {
        throw new Error('storage unavailable');
      }
      return fsMock.indexText;
    }
    writeSync(): void {
      // The parsed list is written back; the test asserts the model, not the file.
    }
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