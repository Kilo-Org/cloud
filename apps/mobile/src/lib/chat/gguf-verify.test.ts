/* eslint-disable typescript-eslint/require-await -- an inspect that never awaits is the native read the test scripts */
import { describe, expect, it, vi } from 'vitest';

import { type GgufInspection, type GgufStorage } from './gguf-records';
import { type GgufTransfer } from './gguf-transfers';
import { verifyModel } from './gguf-verify';

const MODEL_SHA = 'a'.repeat(64);
const PROJECTOR_SHA = 'b'.repeat(64);

const MODEL_FILE: GgufTransfer = {
  url: 'https://example.com/eyes.gguf',
  name: 'eyes.gguf',
  part: 'eyes.gguf.part',
  expected: 1000,
  sha256: MODEL_SHA,
};

const PROJECTOR_FILE: GgufTransfer = {
  url: 'https://example.com/mmproj-eyes.gguf',
  name: 'eyes.mmproj.gguf',
  part: 'eyes.mmproj.gguf.part',
  expected: 200,
  sha256: PROJECTOR_SHA,
};

/** A device holding both partial files, so a pass can hash and read them. */
function storageOf(): GgufStorage & { readonly hashed: string[] } {
  const hashed: string[] = [];
  return {
    hashed,
    freeBytes: () => 8_000_000_000,
    list: () => [MODEL_FILE.part, PROJECTOR_FILE.part],
    size: () => 0,
    sha256: async name => {
      hashed.push(name);
      return name === MODEL_FILE.part ? MODEL_SHA : PROJECTOR_SHA;
    },
    remove: () => undefined,
    move: () => undefined,
    path: name => `/models/${name}`,
    readIndex: () => null,
    writeIndex: () => undefined,
    createDownload: () => {
      throw new Error('no download starts here');
    },
  };
}

const INPUT = {
  fileId: 'eyes',
  name: 'Eyes',
  transfers: [MODEL_FILE, PROJECTOR_FILE],
  sizeBytes: 1200,
} as const;

describe('verifying a downloaded model', () => {
  it('refuses a projector that reads no images after one hash and one load', async () => {
    const storage = storageOf();
    const inspect = vi.fn(async (): Promise<GgufInspection> => ({
      contextWindow: 4096,
      tools: false,
      vision: false,
      thinking: false,
    }));

    const verdict = await verifyModel(storage, inspect, INPUT);

    expect(verdict).toEqual({ ok: false, problem: 'invalidFile' });
    // The verdict a projector gives cannot change between reads, so nothing hashes
    // or loads a second time.
    expect(storage.hashed).toHaveLength(2);
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('reads again after a refused load and accepts the model when the next read works', async () => {
    const storage = storageOf();
    let reads = 0;
    const inspect = vi.fn(async (): Promise<GgufInspection> => {
      reads += 1;
      if (reads === 1) {
        throw new Error('load refused');
      }
      return { contextWindow: 4096, tools: false, vision: true, thinking: false };
    });

    const verdict = await verifyModel(storage, inspect, INPUT);

    expect(verdict).toMatchObject({ ok: true, model: { fileId: 'eyes', vision: true } });
    expect(inspect).toHaveBeenCalledTimes(2);
    expect(storage.hashed).toHaveLength(4);
  });

  it('gives up after the second refused load', async () => {
    const storage = storageOf();
    const inspect = vi.fn(() => Promise.reject(new Error('load refused')));

    const verdict = await verifyModel(storage, inspect, INPUT);

    expect(verdict).toEqual({ ok: false, problem: 'invalidFile' });
    expect(inspect).toHaveBeenCalledTimes(2);
  });
});
