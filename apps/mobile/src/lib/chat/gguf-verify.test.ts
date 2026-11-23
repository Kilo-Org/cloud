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

/**
 * A device holding both partial files, so a pass can hash and read them.
 * `refuseMove` makes every move throw, as a permission or I/O refusal does; `hideFiles`
 * omits both names from the listing, so the move finds no file to place.
 * `refuseHash` makes the device refuse to compute a digest: a number refuses
 * that many hashes of a file and then works, `'always'` refuses every one.
 * `wrongDigest` makes a computed digest differ from the published one.
 */
function storageOf(
  options: {
    readonly refuseMove?: boolean;
    readonly hideFiles?: boolean;
    readonly refuseHash?: number | 'always';
    readonly wrongDigest?: boolean;
  } = {}
): GgufStorage & { readonly hashed: string[] } {
  const hashed: string[] = [];
  let refused = 0;
  return {
    hashed,
    freeBytes: () => 8_000_000_000,
    list: () => (options.hideFiles === true ? [] : [MODEL_FILE.part, PROJECTOR_FILE.part]),
    size: () => 0,
    sha256: async name => {
      hashed.push(name);
      const limit = options.refuseHash;
      if (limit === 'always' || (typeof limit === 'number' && refused < limit)) {
        refused += 1;
        throw new Error('read failed');
      }
      if (options.wrongDigest === true) {
        return 'f'.repeat(64);
      }
      return name === MODEL_FILE.part ? MODEL_SHA : PROJECTOR_SHA;
    },
    remove: () => undefined,
    move: () => {
      if (options.refuseMove === true) {
        throw new Error('move refused');
      }
    },
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

  it('reads a hash the device refused once again, and accepts the model when the next read works', async () => {
    const storage = storageOf({ refuseHash: 1 });
    const inspect = vi.fn(async (): Promise<GgufInspection> => ({
      contextWindow: 4096,
      tools: false,
      vision: true,
      thinking: false,
    }));

    const verdict = await verifyModel(storage, inspect, INPUT);

    expect(verdict).toMatchObject({ ok: true, model: { fileId: 'eyes' } });
    // One refused hash, then the whole second pass: no digest was computed the
    // first time, so the refusal is not a verdict on the bytes.
    expect(storage.hashed).toHaveLength(3);
    expect(storage.hashed[0]).toBe(MODEL_FILE.part);
  });

  it('reports a hash the device would not compute twice as unreadable', async () => {
    const storage = storageOf({ refuseHash: 'always' });
    const inspect = vi.fn(async (): Promise<GgufInspection> => ({
      contextWindow: 4096,
      tools: false,
      vision: true,
      thinking: false,
    }));

    const verdict = await verifyModel(storage, inspect, INPUT);

    // The last pass names what refused: nothing read, so nothing about the bytes.
    expect(verdict).toEqual({ ok: false, problem: 'unreadable' });
    expect(storage.hashed).toHaveLength(2);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('ends a digest that differs as a checksum after one hash', async () => {
    const storage = storageOf({ wrongDigest: true });
    const inspect = vi.fn(async (): Promise<GgufInspection> => ({
      contextWindow: 4096,
      tools: false,
      vision: true,
      thinking: false,
    }));

    const verdict = await verifyModel(storage, inspect, INPUT);

    // The digest was computed and differs: that is the verdict itself, so it is
    // never read again.
    expect(verdict).toEqual({ ok: false, problem: 'checksum' });
    expect(storage.hashed).toHaveLength(1);
    expect(inspect).not.toHaveBeenCalled();
  });

  it('reports a refused move as a write failure, not a bad file', async () => {
    const storage = storageOf({ refuseMove: true });
    const inspect = vi.fn(async (): Promise<GgufInspection> => ({
      contextWindow: 4096,
      tools: false,
      vision: true,
      thinking: false,
    }));

    const verdict = await verifyModel(storage, inspect, INPUT);

    expect(verdict).toEqual({ ok: false, problem: 'writeFailed' });
    // The device refused the move, so the bytes are never read a second time.
    expect(inspect).toHaveBeenCalledTimes(1);
  });

  it('reports a file at neither place as an invalid file', async () => {
    const storage = storageOf({ hideFiles: true });
    const inspect = vi.fn(async (): Promise<GgufInspection> => ({
      contextWindow: 4096,
      tools: false,
      vision: true,
      thinking: false,
    }));

    const verdict = await verifyModel(storage, inspect, INPUT);

    expect(verdict).toEqual({ ok: false, problem: 'invalidFile' });
  });
});
