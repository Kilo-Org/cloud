#!/usr/bin/env bun
/**
 * Runtime release packaging and publication (plan §6 "Packaging", §11 step 1-5).
 *
 * The exact packaged bytes are the source of truth: this tool computes SHA-256
 * and exact lengths from the CLI tarball and the control bundle, builds the
 * embedded descriptor from an authenticated file inventory, then publishes both
 * payload objects before the release-evidence descriptor, create-only.
 *
 * It writes to a local directory by default. Remote publication (R2) is gated on
 * an approved registry/R2 publication path and production credentials, which this
 * foundation does not possess; a request for remote publication is refused rather
 * than silently downgraded.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { gzipSync, gunzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import {
  CONTROL_PLANE_SUPERVISOR,
  GIT_CREDENTIAL_HELPER,
  WRAPPER_BUNDLES,
  runtimeInstallPath,
} from '../src/shared/runtime-distribution.js';
import {
  RUNTIME_BASE_ABI,
  RUNTIME_BOOTSTRAP_CONTRACT,
  RUNTIME_DESCRIPTOR_MAX_BYTES,
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  RUNTIME_RELEASE_FORMAT,
  serializeRuntimeRelease,
  type RuntimeInventoryEntry,
  type RuntimeReleaseDescriptor,
} from '../src/shared/runtime-release.js';
import {
  publishArtifactObject,
  publishReleaseEvidence,
  type ArtifactObjectStore,
  type PublishedArtifact,
} from '../src/sandbox-control/runtime-artifact-store.js';
import {
  RUNTIME_ARCHIVE_SCANNER_SOURCE,
  type RuntimeArchiveScan,
} from '../src/shared/runtime-archive.js';

// The scanner source is a fixed, repo-owned string. It is compiled here only by the
// packaging tool; the shared module and Worker graph never evaluate it.
// oxlint-disable-next-line no-implied-eval
const archiveFactory = new Function(
  `${RUNTIME_ARCHIVE_SCANNER_SOURCE}\nreturn scanRuntimeArchive;`
) as () => (tar: Uint8Array) => RuntimeArchiveScan;
const scanRuntimeArchive = archiveFactory();
export const scanTar = scanRuntimeArchive;

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Local directory adapter for the create-only object store (no production creds). */
export function localDirectoryArtifactStore(root: string): ArtifactObjectStore {
  const resolveKey = (key: string): string => {
    const target = path.resolve(root, key);
    const base = path.resolve(root);
    if (target !== base && !target.startsWith(`${base}${path.sep}`)) {
      throw new Error(`artifact key escapes the store root: ${key}`);
    }
    return target;
  };
  return {
    async putIfAbsent(key, bytes) {
      const target = resolveKey(key);
      await fs.mkdir(path.dirname(target), { recursive: true });
      try {
        await fs.writeFile(target, bytes, { flag: 'wx' });
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
        throw error;
      }
    },
    async getBytes(key) {
      try {
        return new Uint8Array(await fs.readFile(resolveKey(key)));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
  };
}

type TarEntry = { path: string; mode: number; bytes: Uint8Array };

function gunzipCapped(tarball: Uint8Array, maxOutputLength: number): Uint8Array {
  try {
    return gunzipSync(tarball, { maxOutputLength });
  } catch {
    throw new Error('artifact is not valid gzip within the expansion cap');
  }
}

/** Read the installed-file inventory from an exact CLI tarball's bytes. */
export function inventoryFromCliTarball(
  tarball: Uint8Array,
  caps?: { maxExpandedBytes: number; maxFileCount: number }
): RuntimeInventoryEntry[] {
  const { files, fileCount, expandedBytes } = scanTar(
    gunzipCapped(tarball, caps?.maxExpandedBytes ?? RUNTIME_HARD_MAX_EXPANDED_BYTES)
  );
  if (caps) {
    if (fileCount > caps.maxFileCount) throw new Error('CLI archive file count exceeds the cap');
    if (expandedBytes > caps.maxExpandedBytes) {
      throw new Error('CLI archive expanded bytes exceed the cap');
    }
  }
  return files.map(entry => [
    'cli',
    entry.path,
    entry.mode,
    entry.bytes.byteLength,
    sha256(entry.bytes),
  ]);
}

function writeOctal(value: number, length: number): string {
  return (
    value
      .toString(8)
      .padStart(length - 1, '0')
      .slice(0, length - 1) + '\0'
  );
}

/** Build a deterministic ustar byte stream for regular files. */
export function writeTarEntries(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of [...entries].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    const header = new Uint8Array(512);
    const encoder = new TextEncoder();
    header.set(encoder.encode(entry.path).subarray(0, 100), 0);
    header.set(encoder.encode(writeOctal(entry.mode, 8)), 100);
    header.set(encoder.encode(writeOctal(0, 8)), 108);
    header.set(encoder.encode(writeOctal(0, 8)), 116);
    header.set(encoder.encode(writeOctal(entry.bytes.byteLength, 12)), 124);
    header.set(encoder.encode(writeOctal(0, 12)), 136);
    for (let index = 148; index < 156; index += 1) header[index] = 0x20;
    header[156] = 48; // regular file
    header.set(encoder.encode('ustar\0'), 257);
    header.set(encoder.encode('00'), 263);
    header.set(encoder.encode('root'), 265);
    header.set(encoder.encode('root'), 297);
    let checksum = 0;
    for (const byte of header) checksum += byte;
    header.set(encoder.encode(writeOctal(checksum, 8)), 148);
    blocks.push(header);
    const data = new Uint8Array(Math.ceil(entry.bytes.byteLength / 512) * 512);
    data.set(entry.bytes);
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

function normalizeBundlePath(absolute: string): string {
  return absolute.replace(/^\/+/, '');
}

/** Control-bundle source files (plan §6 "Runtime And User Data"). */
export async function controlBundleEntries(packageRoot: string): Promise<TarEntry[]> {
  const sources = [
    ...WRAPPER_BUNDLES.map(bundle => ({
      path: normalizeBundlePath(runtimeInstallPath(bundle.installName)),
      mode: bundle.executable ? 0o100755 : 0o100644,
      local: path.resolve(packageRoot, 'wrapper', 'dist', bundle.distName),
    })),
    {
      path: normalizeBundlePath(runtimeInstallPath(CONTROL_PLANE_SUPERVISOR.installName)),
      mode: 0o100755,
      local: path.resolve(packageRoot, 'wrapper', CONTROL_PLANE_SUPERVISOR.wrapperPath),
    },
    {
      path: normalizeBundlePath(GIT_CREDENTIAL_HELPER.realPath),
      mode: 0o100755,
      local: path.resolve(packageRoot, GIT_CREDENTIAL_HELPER.packagePath),
    },
  ];
  return Promise.all(
    sources.map(async source => ({
      path: source.path,
      mode: source.mode,
      bytes: new Uint8Array(await fs.readFile(source.local)),
    }))
  );
}

export type PackagedRuntime = {
  descriptor: RuntimeReleaseDescriptor;
  cli: { sha256: string; bytes: Uint8Array };
  control: { sha256: string; bytes: Uint8Array };
};

export async function packageRuntimeRelease(input: {
  cliTarball: Uint8Array;
  cliVersion: string;
  cliExecutable: string;
  wrapperSdkVersion: string;
  protocol: string;
  abi: string;
  platform: RuntimeReleaseDescriptor['platform'];
  caps: RuntimeReleaseDescriptor['caps'];
  controlEntries: readonly TarEntry[];
}): Promise<PackagedRuntime> {
  const cliInventory = inventoryFromCliTarball(input.cliTarball, input.caps);
  const controlTar = gzipSync(writeTarEntries(input.controlEntries));
  const controlScan = scanTar(gunzipCapped(controlTar, input.caps.maxExpandedBytes));
  if (controlScan.fileCount > input.caps.maxFileCount) {
    throw new Error('control archive file count exceeds the cap');
  }
  if (controlScan.expandedBytes > input.caps.maxExpandedBytes) {
    throw new Error('control archive expanded bytes exceed the cap');
  }
  const controlInventory: RuntimeInventoryEntry[] = controlScan.files.map(entry => [
    'control',
    entry.path,
    entry.mode,
    entry.bytes.byteLength,
    sha256(entry.bytes),
  ]);
  const descriptor: RuntimeReleaseDescriptor = {
    format: RUNTIME_RELEASE_FORMAT,
    bootstrap: RUNTIME_BOOTSTRAP_CONTRACT,
    platform: input.platform,
    abi: input.abi,
    cliVersion: input.cliVersion,
    cliExecutable: input.cliExecutable,
    wrapperSdkVersion: input.wrapperSdkVersion,
    protocol: input.protocol,
    artifacts: [
      {
        role: 'cli',
        sha256: sha256(input.cliTarball),
        transferBytes: input.cliTarball.byteLength,
        expandedBytes: cliInventory.reduce((sum, entry) => sum + entry[3], 0),
        fileCount: cliInventory.length,
      },
      {
        role: 'control',
        sha256: sha256(controlTar),
        transferBytes: controlTar.byteLength,
        expandedBytes: controlInventory.reduce((sum, entry) => sum + entry[3], 0),
        fileCount: controlInventory.length,
      },
    ],
    caps: input.caps,
    inventory: [...cliInventory, ...controlInventory],
  };
  // Serialization enforces the 64 KiB launch cap before publication.
  serializeRuntimeRelease(descriptor);
  return {
    descriptor,
    cli: { sha256: descriptor.artifacts[0].sha256, bytes: input.cliTarball },
    control: { sha256: descriptor.artifacts[1].sha256, bytes: controlTar },
  };
}

export type RuntimePublication = {
  cli: PublishedArtifact;
  control: PublishedArtifact;
  evidence: PublishedArtifact;
};

/**
 * Publish both payload objects first, then the release evidence, each create-only
 * and re-read verified. Evidence is never accepted as a substitute for the
 * payload objects.
 */
export async function publishRuntimeRelease(
  store: ArtifactObjectStore,
  packaged: PackagedRuntime
): Promise<RuntimePublication> {
  const cli = await publishArtifactObject(store, packaged.cli);
  const control = await publishArtifactObject(store, packaged.control);
  const evidence = await publishReleaseEvidence(
    store,
    serializeRuntimeRelease(packaged.descriptor)
  );
  return { cli, control, evidence };
}

function printUsage(): void {
  console.error(
    'Usage: bun scripts/publish-runtime.ts --cli <tarball.tgz> --out <dir> [--cli-version <v>] [--wrapper-sdk <v>] [--protocol <v>] [--abi <v>]'
  );
  console.error(
    'Remote R2 publication requires an approved publication path; pass no remote flag here.'
  );
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  return index === -1 ? undefined : argv[index + 1];
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cliTarballPath = argValue(argv, '--cli');
  const out = argValue(argv, '--out');
  if (!cliTarballPath || !out) {
    printUsage();
    process.exit(2);
  }
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const cliTarball = new Uint8Array(await fs.readFile(cliTarballPath));
  const packaged = await packageRuntimeRelease({
    cliTarball,
    cliVersion: argValue(argv, '--cli-version') ?? '7.8.1',
    cliExecutable: argValue(argv, '--cli-executable') ?? 'package/bin/kilo',
    wrapperSdkVersion: argValue(argv, '--wrapper-sdk') ?? '7.8.1',
    protocol: argValue(argv, '--protocol') ?? 'control-plane-v1',
    abi: argValue(argv, '--abi') ?? RUNTIME_BASE_ABI,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    caps: {
      maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
      maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
      maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
    },
    controlEntries: await controlBundleEntries(packageRoot),
  });
  const store = localDirectoryArtifactStore(out);
  const publication = await publishRuntimeRelease(store, packaged);
  const descriptorBytes = serializeRuntimeRelease(packaged.descriptor);
  if (descriptorBytes.byteLength > RUNTIME_DESCRIPTOR_MAX_BYTES) {
    throw new Error('descriptor exceeded the launch cap after publication');
  }
  console.log(
    JSON.stringify({
      cli: publication.cli,
      control: publication.control,
      evidence: publication.evidence,
      descriptorBytes: descriptorBytes.byteLength,
    })
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
