import { createHash } from 'node:crypto';
import { z } from 'zod';
import fs from 'node:fs/promises';
import path from 'node:path';
import { zstdCompressSync, zstdDecompressSync, gunzipSync } from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { KILO_CLI_VERSION } from '../src/shared/kilo-cli-version.js';
import { CONTROL_PLANE_PROTOCOL_VERSION } from '../src/shared/control-plane-protocol.js';
import { remoteArtifactStore } from './runtime-publish-store.js';
import { downloadVerified } from './runtime-cli-artifact.js';
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
  RUNTIME_HARD_MAX_EXPANDED_BYTES,
  RUNTIME_HARD_MAX_FILE_COUNT,
  RUNTIME_HARD_MAX_TRANSFER_BYTES,
  RUNTIME_RELEASE_FORMAT,
  serializeRuntimeRelease,
  type RuntimeInventoryEntry,
  type RuntimeReleaseDescriptor,
} from '../src/sandbox-control/runtime-release.js';
import {
  runtimeArtifactObjectKey,
  runtimeArtifactReleaseKey,
  type ArtifactObjectStore,
} from '../src/sandbox-control/runtime-artifact-keys.js';
import {
  RUNTIME_ARCHIVE_SCANNER_SOURCE,
  type RuntimeArchiveScan,
} from '../src/sandbox-control/runtime-archive.js';

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
  const digits = value.toString(8);
  if (!Number.isSafeInteger(value) || value < 0 || digits.length >= length)
    throw new Error('tar numeric field overflow');
  return digits.padStart(length - 1, '0') + '\0';
}

/** Build a deterministic ustar byte stream for regular files. */
export function writeTarEntries(entries: readonly TarEntry[]): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const entry of [...entries].sort((left, right) => (left.path < right.path ? -1 : 1))) {
    const header = new Uint8Array(512);
    const encoder = new TextEncoder();
    const name = encoder.encode(entry.path);
    if (name.byteLength > 100) throw new Error('tar path exceeds the ustar name field');
    header.set(name, 0);
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
  const cliTar = zstdCompressSync(gunzipCapped(input.cliTarball, input.caps.maxExpandedBytes));
  const controlTar = zstdCompressSync(writeTarEntries(input.controlEntries));
  const controlScan = scanTar(
    zstdDecompressSync(controlTar, { maxOutputLength: input.caps.maxExpandedBytes })
  );
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
        sha256: sha256(cliTar),
        transferBytes: cliTar.byteLength,
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
    cli: { sha256: descriptor.artifacts[0].sha256, bytes: cliTar },
    control: { sha256: descriptor.artifacts[1].sha256, bytes: controlTar },
  };
}

export type PublishedArtifact = { key: string; sha256: string; size: number; created: boolean };

async function publishImmutableObject(
  store: ArtifactObjectStore,
  key: string,
  bytes: Uint8Array,
  contentType: string
): Promise<PublishedArtifact> {
  const expected = sha256(bytes);
  const created = await store.putIfAbsent(key, bytes, contentType);
  const stored = await store.getBytes(key);
  if (stored === null || stored.byteLength !== bytes.byteLength || sha256(stored) !== expected)
    throw new Error('Runtime publication failed stored-byte verification');
  return { key, sha256: expected, size: stored.byteLength, created };
}

export async function publishRuntimeRelease(store: ArtifactObjectStore, packaged: PackagedRuntime) {
  for (const artifact of packaged.descriptor.artifacts) {
    const payload = packaged[artifact.role];
    if (
      sha256(payload.bytes) !== artifact.sha256 ||
      payload.sha256 !== artifact.sha256 ||
      payload.bytes.byteLength !== artifact.transferBytes
    )
      throw new Error('Runtime payload does not match its descriptor');
  }
  const cli = await publishImmutableObject(
    store,
    runtimeArtifactObjectKey(packaged.cli.sha256),
    packaged.cli.bytes,
    'application/zstd'
  );
  const control = await publishImmutableObject(
    store,
    runtimeArtifactObjectKey(packaged.control.sha256),
    packaged.control.bytes,
    'application/zstd'
  );
  const bytes = serializeRuntimeRelease(packaged.descriptor);
  const descriptor = await publishImmutableObject(
    store,
    runtimeArtifactReleaseKey(sha256(bytes)),
    bytes,
    'application/json'
  );
  return { cli, control, descriptor };
}

function argValue(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  if (index < 0) return undefined;
  const value = argv[index + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value`);
  return value;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const out = argValue(argv, '--out');
  const bucket = argValue(argv, '--bucket');
  if ((out === undefined) === (bucket === undefined))
    throw new Error('Specify exactly one target: --out <directory> or --bucket <name>');
  const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const build = spawnSync('bun', ['run', 'build:wrapper'], { cwd: packageRoot, stdio: 'inherit' });
  if (build.status !== 0) throw new Error('Wrapper build failed');
  const version = argValue(argv, '--cli-version') ?? KILO_CLI_VERSION;
  const file = argValue(argv, '--cli');
  const cliTarball = file
    ? new Uint8Array(await fs.readFile(file))
    : await downloadVerified(version);
  const wrapperManifest = z
    .object({ dependencies: z.object({ '@kilocode/sdk': z.string().min(1) }) })
    .parse(JSON.parse(await fs.readFile(path.join(packageRoot, 'wrapper/package.json'), 'utf8')));
  const packaged = await packageRuntimeRelease({
    cliTarball,
    cliVersion: version,
    cliExecutable: 'package/bin/kilo',
    wrapperSdkVersion: wrapperManifest.dependencies['@kilocode/sdk'],
    protocol: String(CONTROL_PLANE_PROTOCOL_VERSION),
    abi: RUNTIME_BASE_ABI,
    platform: { os: 'linux', arch: 'x64', libc: 'glibc', cpu: 'baseline' },
    caps: {
      maxTransferBytes: RUNTIME_HARD_MAX_TRANSFER_BYTES,
      maxExpandedBytes: RUNTIME_HARD_MAX_EXPANDED_BYTES,
      maxFileCount: RUNTIME_HARD_MAX_FILE_COUNT,
    },
    controlEntries: await controlBundleEntries(packageRoot),
  });
  const {
    RUNTIME_R2_ACCOUNT_ID: accountId,
    RUNTIME_R2_ACCESS_KEY_ID: accessKeyId,
    RUNTIME_R2_SECRET_ACCESS_KEY: secretAccessKey,
  } = process.env;
  if (bucket && (!accountId || !accessKeyId || !secretAccessKey))
    throw new Error('Runtime publisher credentials are missing');
  const store =
    out !== undefined
      ? localDirectoryArtifactStore(out)
      : bucket && accountId && accessKeyId && secretAccessKey
        ? remoteArtifactStore({ accountId, bucket, accessKeyId, secretAccessKey })
        : null;
  if (!store) throw new Error('Runtime publisher target is invalid');
  console.log(JSON.stringify(await publishRuntimeRelease(store, packaged)));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
