import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zstdDecompressSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { fixtureRuntime } from '../test/runtime-installer/fixtures.js';
import {
  localDirectoryArtifactStore,
  publishRuntimeRelease,
  scanTar,
  sha256,
} from './publish-runtime.js';
import {
  runtimeArtifactObjectKey,
  runtimeArtifactReleaseKey,
  type ArtifactObjectStore,
} from '../src/sandbox-control/runtime-artifact-keys.js';
import { serializeRuntimeRelease } from '../src/sandbox-control/runtime-release.js';

function memoryStore() {
  const objects = new Map<string, Uint8Array>();
  const store: ArtifactObjectStore = {
    async putIfAbsent(key, bytes) {
      if (objects.has(key)) return false;
      objects.set(key, bytes.slice());
      return true;
    },
    async getBytes(key) {
      return objects.get(key) ?? null;
    },
  };
  return { objects, store };
}

describe('runtime packaging and publication', () => {
  it('builds independent deterministic CLI and control payloads', async () => {
    const first = await fixtureRuntime('B', 'B');
    const again = await fixtureRuntime('B', 'B');
    const controlOnly = await fixtureRuntime('B', 'C');
    const cliOnly = await fixtureRuntime('A', 'B');
    expect(first.cli.sha256).toBe(again.cli.sha256);
    expect(first.control.sha256).toBe(again.control.sha256);
    expect(controlOnly.cli.sha256).toBe(first.cli.sha256);
    expect(controlOnly.control.sha256).not.toBe(first.control.sha256);
    expect(cliOnly.cli.sha256).not.toBe(first.cli.sha256);
    expect(cliOnly.control.sha256).toBe(first.control.sha256);
    for (const artifact of first.descriptor.artifacts) {
      const payload = first[artifact.role];
      const archive = scanTar(zstdDecompressSync(payload.bytes));
      expect(payload.sha256).toBe(sha256(payload.bytes));
      expect(archive.fileCount).toBe(artifact.fileCount);
      expect(archive.expandedBytes).toBe(artifact.expandedBytes);
    }
  });

  it('publishes complete payloads before the immutable descriptor and reuses identical bytes', async () => {
    const runtime = await fixtureRuntime();
    const { objects, store } = memoryStore();
    const first = await publishRuntimeRelease(store, runtime);
    const key = runtimeArtifactReleaseKey(sha256(serializeRuntimeRelease(runtime.descriptor)));
    expect([...objects.keys()]).toEqual([
      runtimeArtifactObjectKey(runtime.cli.sha256),
      runtimeArtifactObjectKey(runtime.control.sha256),
      key,
    ]);
    expect(first.descriptor.key).toBe(key);
    const retry = await publishRuntimeRelease(store, runtime);
    expect([retry.cli.created, retry.control.created, retry.descriptor.created]).toEqual([
      false,
      false,
      false,
    ]);
    expect(objects.size).toBe(3);
  });

  it('rejects a conflicting payload without publishing a descriptor', async () => {
    const runtime = await fixtureRuntime();
    const { objects, store } = memoryStore();
    objects.set(runtimeArtifactObjectKey(runtime.control.sha256), Buffer.from('corrupt'));
    await expect(publishRuntimeRelease(store, runtime)).rejects.toThrow('stored-byte verification');
    expect([...objects.keys()].some(key => key.includes('/releases/'))).toBe(false);
  });

  it('rejects a missing stored payload and mismatched descriptor bytes', async () => {
    const runtime = await fixtureRuntime();
    const missing: ArtifactObjectStore = {
      putIfAbsent: async () => true,
      getBytes: async () => null,
    };
    await expect(publishRuntimeRelease(missing, runtime)).rejects.toThrow(
      'stored-byte verification'
    );
    const { objects, store } = memoryStore();
    runtime.cli.bytes = Buffer.from('different');
    await expect(publishRuntimeRelease(store, runtime)).rejects.toThrow(
      'does not match its descriptor'
    );
    expect(objects.size).toBe(0);
  });

  it('creates local objects exclusively and refuses store-root escapes', async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'runtime-publication-'));
    try {
      const runtime = await fixtureRuntime();
      const store = localDirectoryArtifactStore(directory);
      const result = await publishRuntimeRelease(store, runtime);
      expect(sha256(await fs.readFile(path.join(directory, result.cli.key)))).toBe(
        runtime.cli.sha256
      );
      await expect(
        store.putIfAbsent('../outside', Buffer.from('bad'), 'application/octet-stream')
      ).rejects.toThrow('escapes the store root');
    } finally {
      await fs.rm(directory, { recursive: true, force: true });
    }
  });
});
