import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  localDirectoryArtifactStore,
  packageRuntimeRelease,
  scanTar,
  writeTarEntries,
} from '../../scripts/publish-runtime.js';
import {
  ArtifactByteMismatchError,
  ArtifactConflictError,
  publishImmutableObject,
  publishReleaseEvidence,
  runtimeArtifactObjectKey,
  runtimeArtifactReleaseKey,
  sha256Hex,
  type ArtifactObjectStore,
} from './runtime-artifact-store.js';
import {
  checkRuntimeFreeBase,
  verifyRelease,
  type PreflightReader,
} from '../../scripts/runtime-release-preflight.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_BOOTSTRAP_CONTRACT,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  RUNTIME_RELEASE_FORMAT,
  serializeRuntimeRelease,
  type RuntimeReleaseDescriptor,
} from '../shared/runtime-release.js';

const encoder = new TextEncoder();

let root: string;
let store: ArtifactObjectStore;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'artifact-store-'));
  store = localDirectoryArtifactStore(root);
});

afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});

describe('content-addressed object publication', () => {
  it('creates an object, re-reads it, and reports the created state', async () => {
    const bytes = encoder.encode('cli payload');
    const sha256 = await sha256Hex(bytes);
    const result = await publishImmutableObject(store, {
      key: runtimeArtifactObjectKey(sha256),
      bytes,
      expectedSha256: sha256,
      contentType: 'application/gzip',
    });
    expect(result.created).toBe(true);
    expect(result.size).toBe(bytes.byteLength);
    expect(await store.getBytes(runtimeArtifactObjectKey(sha256))).toEqual(bytes);
  });

  it('fails when the bytes do not match the declared hash', async () => {
    const bytes = encoder.encode('tampered');
    await expect(
      publishImmutableObject(store, {
        key: runtimeArtifactObjectKey('a'.repeat(64)),
        bytes,
        expectedSha256: 'a'.repeat(64),
        contentType: 'application/gzip',
      })
    ).rejects.toBeInstanceOf(ArtifactByteMismatchError);
  });

  it('re-reads the release evidence object and fails on a stored byte mismatch', async () => {
    const descriptor = encoder.encode('{"format":1}');
    const evidence = await publishReleaseEvidence(store, descriptor);
    const descriptorSha256 = await sha256Hex(descriptor);
    expect(evidence.key).toBe(runtimeArtifactReleaseKey(descriptorSha256));
    expect(await store.getBytes(evidence.key)).toEqual(descriptor);
    // A corrupt stored evidence object fails the next publication re-read.
    await fs.writeFile(path.join(root, evidence.key), encoder.encode('corrupt'));
    await expect(publishReleaseEvidence(store, descriptor)).rejects.toBeInstanceOf(
      ArtifactConflictError
    );
  });
});

function rawTar(
  entries: readonly { path: string; type: number; mode: number; data: Uint8Array }[]
): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of entries) {
    const header = new Uint8Array(512);
    const octal = (value: number, length: number) =>
      value
        .toString(8)
        .padStart(length - 1, '0')
        .slice(0, length - 1) + '\0';
    header.set(encoder.encode(entry.path).subarray(0, 100), 0);
    header.set(encoder.encode(octal(entry.mode, 8)), 100);
    header.set(encoder.encode(octal(0, 8)), 108);
    header.set(encoder.encode(octal(0, 8)), 116);
    header.set(encoder.encode(octal(entry.data.byteLength, 12)), 124);
    header.set(encoder.encode(octal(0, 12)), 136);
    for (let index = 148; index < 156; index += 1) header[index] = 0x20;
    header[156] = entry.type;
    header.set(encoder.encode('ustar\0'), 257);
    header.set(encoder.encode('00'), 263);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(encoder.encode(octal(checksum, 8)), 148);
    blocks.push(header);
    const data = new Uint8Array(Math.ceil(entry.data.byteLength / 512) * 512);
    data.set(entry.data);
    blocks.push(data);
  }
  blocks.push(new Uint8Array(1024));
  const total = blocks.reduce((sum, block) => sum + block.byteLength, 0);
  const tar = new Uint8Array(total);
  let offset = 0;
  for (const block of blocks) {
    tar.set(block, offset);
    offset += block.byteLength;
  }
  return tar;
}

describe('publisher archive validation', () => {
  const payload = encoder.encode('file bytes\n');

  it('accepts regular files and normalizes directory entries with a trailing slash', () => {
    const tar = rawTar([
      { path: 'usr/local/bin/', type: 53, mode: 0o100755, data: new Uint8Array(0) },
      { path: 'usr/local/bin/tool', type: 48, mode: 0o100755, data: payload },
    ]);
    const { files, fileCount, expandedBytes } = scanTar(tar);
    expect(fileCount).toBe(1);
    expect(expandedBytes).toBe(payload.byteLength);
    expect(files.map(entry => entry.path)).toEqual(['usr/local/bin/tool']);
  });

  it('rejects symlinks, hard links, and devices', () => {
    for (const type of [50, 49, 51]) {
      const tar = rawTar([{ path: 'entry', type, mode: 0o100755, data: new Uint8Array(0) }]);
      expect(() => scanTar(tar)).toThrow(/unsupported tar entry type/);
    }
  });

  it('rejects duplicate paths, truncation, and a bad checksum', () => {
    const duplicate = rawTar([
      { path: 'dup', type: 48, mode: 0o100644, data: payload },
      { path: 'dup', type: 48, mode: 0o100644, data: payload },
    ]);
    expect(() => scanTar(duplicate)).toThrow(/duplicate archive path/);

    const big = rawTar([
      { path: 'big', type: 48, mode: 0o100644, data: encoder.encode('x'.repeat(2048)) },
    ]);
    expect(() => scanTar(big.subarray(0, 700))).toThrow(/truncated tar entry/);

    const bad = rawTar([{ path: 'bad', type: 48, mode: 0o100644, data: payload }]).slice();
    bad[0] = bad[0] ^ 0xff;
    expect(() => scanTar(bad)).toThrow(/checksum mismatch/);
  });
});

describe('publisher packaging caps', () => {
  it('rejects a CLI archive whose file count exceeds the declared cap', async () => {
    const cliTarball = gzipSync(
      writeTarEntries([
        { path: 'package/bin/kilo', mode: 0o100755, bytes: encoder.encode('#!/bin/sh\n') },
        { path: 'package/lib/a.js', mode: 0o100644, bytes: encoder.encode('a\n') },
      ])
    );
    await expect(
      packageRuntimeRelease({
        cliTarball,
        cliVersion: '7.8.1',
        cliExecutable: 'package/bin/kilo',
        wrapperSdkVersion: '7.8.1',
        protocol: 'control-plane-v1',
        abi: 'kilo-runtime-base-v1',
        platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
        caps: { maxTransferBytes: 1024 * 1024, maxExpandedBytes: 1024 * 1024, maxFileCount: 1 },
        controlEntries: [{ path: 'usr/local/bin/x', mode: 0o100755, bytes: encoder.encode('x') }],
      })
    ).rejects.toThrow();
  });
});

/**
 * The read-only release preflight (`scripts/runtime-release-preflight.ts`) is
 * otherwise unexercised. Its descriptor/object checks are pure apart from the
 * injected reader, so the cases live here with the publisher/object fixtures
 * rather than in a separate unit file.
 */
async function makeRelease(): Promise<{ bytes: Uint8Array; objects: Map<string, Uint8Array> }> {
  const cliBytes = encoder.encode('cli-bytes');
  const controlBytes = encoder.encode('control-bytes');
  const cliSha = await sha256Hex(cliBytes);
  const controlSha = await sha256Hex(controlBytes);
  const descriptor: RuntimeReleaseDescriptor = {
    format: RUNTIME_RELEASE_FORMAT,
    bootstrap: RUNTIME_BOOTSTRAP_CONTRACT,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    abi: RUNTIME_BASE_ABI,
    cliVersion: '7.8.1',
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: '7.8.1',
    protocol: 'control-plane-v1',
    artifacts: [
      {
        role: 'cli',
        sha256: cliSha,
        transferBytes: cliBytes.byteLength,
        expandedBytes: cliBytes.byteLength,
        fileCount: 1,
      },
      {
        role: 'control',
        sha256: controlSha,
        transferBytes: controlBytes.byteLength,
        expandedBytes: controlBytes.byteLength,
        fileCount: 1,
      },
    ],
    caps: {
      maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
      maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
      maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
    },
    inventory: [
      ['cli', 'package/bin/kilo', 0o100755, cliBytes.byteLength, cliSha],
      ['control', 'opt/kilo-cloud/supervisor.js', 0o100755, controlBytes.byteLength, controlSha],
    ],
  };
  const bytes = serializeRuntimeRelease(descriptor);
  const objects = new Map<string, Uint8Array>([
    [runtimeArtifactObjectKey(cliSha), cliBytes],
    [runtimeArtifactObjectKey(controlSha), controlBytes],
    [runtimeArtifactReleaseKey(await sha256Hex(bytes)), bytes],
  ]);
  return { bytes, objects };
}

const readerFrom =
  (objects: Map<string, Uint8Array>): PreflightReader =>
  async key =>
    objects.get(key) ?? null;

describe('read-only release preflight', () => {
  it('passes a complete, hashed, published release', async () => {
    const { bytes, objects } = await makeRelease();
    const checks = await verifyRelease(bytes, {
      descriptorSha256: await sha256Hex(bytes),
      read: readerFrom(objects),
    });
    for (const check of checks) expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
  });

  it('fails when an artifact object is not published', async () => {
    const { bytes, objects } = await makeRelease();
    const cliKey = runtimeArtifactObjectKey(
      JSON.parse(new TextDecoder().decode(bytes)).artifacts[0].sha256
    );
    objects.delete(cliKey);
    const checks = await verifyRelease(bytes, { read: readerFrom(objects) });
    const cli = checks.find(check => check.name.startsWith('cli artifact'));
    expect(cli?.passed).toBe(false);
    expect(cli?.detail).toContain('not published');
  });

  it('fails when a stored object does not match its declared size and hash', async () => {
    const { bytes, objects } = await makeRelease();
    const cliKey = runtimeArtifactObjectKey(
      JSON.parse(new TextDecoder().decode(bytes)).artifacts[0].sha256
    );
    objects.set(cliKey, encoder.encode('tampered'));
    const checks = await verifyRelease(bytes, { read: readerFrom(objects) });
    expect(checks.find(check => check.name.startsWith('cli artifact'))?.passed).toBe(false);
  });

  it('fails when the descriptor declares a different base ABI', async () => {
    const { bytes, objects } = await makeRelease();
    const mutated = new TextDecoder().decode(bytes).replace(RUNTIME_BASE_ABI, 'other-abi-v1');
    const checks = await verifyRelease(encoder.encode(mutated), { read: readerFrom(objects) });
    expect(checks.find(check => check.name.includes('base ABI'))?.passed).toBe(false);
  });

  it('fails a descriptor above the launch byte cap and does not read objects', async () => {
    let reads = 0;
    const checks = await verifyRelease(encoder.encode('x'.repeat(65_537)), {
      read: async () => {
        reads += 1;
        return null;
      },
    });
    expect(checks.find(check => check.name.includes('byte cap'))?.passed).toBe(false);
    expect(checks.find(check => check.name.includes('schema'))?.passed).toBe(false);
    expect(reads).toBe(0);
  });

  it('passes the base-contract checks for the repository Dockerfiles', () => {
    for (const check of checkRuntimeFreeBase()) {
      expect(check.passed, `${check.name}: ${check.detail}`).toBe(true);
    }
  });
});
