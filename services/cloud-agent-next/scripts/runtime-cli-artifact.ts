import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';
import { RUNTIME_HARD_MAX_TRANSFER_BYTES } from '../src/sandbox-control/runtime-release.js';
import type { RuntimeHarness } from '../src/shared/control-plane-runtime-contract.js';
import { KILO_CLI_VERSION } from '../src/shared/kilo-cli-version.js';

/**
 * Pinned Kilo CLI platform tarball resolution (plan §6 "Tested Release Set").
 *
 * The runtime release embeds the complete CLI platform distribution. The local
 * preparation and upgrade tooling download it from the npm registry and verify
 * the registry's own integrity hash before packaging, so a corrupted or
 * substituted tarball never reaches the publisher. The measured SHA-256 of the
 * pinned version is a second, registry-independent check.
 *
 * Publication keeps the verified pinned tarball in the private runtime bucket,
 * so only the first publication of a pinned version depends on the registry.
 * A cached tarball is accepted only when it matches the pinned SHA-256.
 *
 * Shared so the integrity rule has one owner across the tooling.
 */

export const CLI_PACKAGE = '@kilocode/cli-linux-x64-baseline';

/**
 * The pinned CLI distribution of each harness, with the measured SHA-256 of its
 * tarball. The startup probe compares `--version` output with `reportedVersion`.
 */
export const PINNED_CLIS = {
  kilo: {
    version: KILO_CLI_VERSION,
    sha256: 'dd4920830a587aaab8aec12f64afcff640538fba27c5eb645160e64ba5972217',
    executable: 'package/bin/kilo',
    reportedVersion: KILO_CLI_VERSION,
  },
  kilo2: {
    version: '0.0.0-v2-104',
    sha256: 'dba45ad65f6110bc0c96cefd15842a491c3614e8b469ff17029363e146219f58',
    executable: 'package/bin/kilo2',
    reportedVersion: 'kilo2 v0.0.0-v2-104',
  },
} as const satisfies Record<
  RuntimeHarness,
  { version: string; sha256: string; executable: string; reportedVersion: string }
>;

const localCliPackageSchema = z.object({
  name: z.string().min(1).max(128),
  version: z
    .string()
    .min(1)
    .max(57)
    .regex(/^[0-9A-Za-z][0-9A-Za-z.+-]*$/),
  os: z.array(z.string()).optional(),
  cpu: z.array(z.string()).optional(),
});

/** The package name is the build's only statement of its AVX2 tier. */
const LOCAL_CLI_CPU = new Map<string, 'baseline' | 'modern'>([
  ['@kilocode/cli-linux-x64-baseline', 'baseline'],
  ['@kilocode/cli-linux-x64', 'modern'],
]);

export type LocalCliBuild = {
  directory: string;
  version: string;
  reportedVersion: string;
  executable: string;
  cpu: 'baseline' | 'modern';
};

/**
 * Read the metadata a local `kilo2` platform build must provide before local
 * packaging. Publication still scans the resulting archive and applies the
 * installer caps, so this validates the source layout rather than duplicating
 * the archive checks.
 */
export async function readLocalCliBuild(directory: string): Promise<LocalCliBuild> {
  const root = await fs.realpath(path.resolve(directory)).catch(() => {
    throw new Error(`Local CLI build directory does not exist: ${directory}`);
  });
  if (!(await fs.stat(root)).isDirectory())
    throw new Error(`Local CLI build path is not a directory: ${directory}`);
  const manifest = localCliPackageSchema.parse(
    JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'))
  );
  const cpu = LOCAL_CLI_CPU.get(manifest.name);
  if (cpu === undefined)
    throw new Error(
      `Local CLI build package is not a supported linux x64 distribution: ${manifest.name}`
    );
  if (manifest.os !== undefined && !manifest.os.includes('linux'))
    throw new Error('Local CLI build does not target linux');
  if (manifest.cpu !== undefined && !manifest.cpu.includes('x64'))
    throw new Error('Local CLI build does not target x64');
  const executable = 'package/bin/kilo2';
  const cli = await fs.lstat(path.join(root, 'bin', 'kilo2')).catch(() => undefined);
  if (!cli?.isFile()) throw new Error('Local CLI build is missing bin/kilo2');
  if ((cli.mode & 0o111) === 0) throw new Error('Local CLI build bin/kilo2 is not executable');
  return {
    directory: root,
    version: manifest.version,
    reportedVersion: `kilo2 v${manifest.version}`,
    executable,
    cpu,
  };
}

const registryMetadataSchema = z.object({
  dist: z.object({
    tarball: z.url().refine(value => new URL(value).protocol === 'https:'),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  }),
});

const REGISTRY_ATTEMPTS = 3;

/** Version and digest both key the cache, so a version bump with a stale digest still fails. */
export const pinnedCliSourceKey = (cli: { version: string; sha256: string }) =>
  `runtime-artifacts/v1/sources/cli-linux-x64-baseline-${cli.version}-${cli.sha256}.tgz`;

/** A definitive registry answer; retrying it cannot succeed. */
class RegistryResponseError extends Error {}

/** Retry transport failures and transient statuses, including timeouts while reading the body. */
async function fetchRegistryBytes(
  url: string,
  init: { cap: number; timeoutMs: number; redirect: 'follow' | 'error' },
  request: typeof fetch
): Promise<Uint8Array> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      const response = await request(url, {
        signal: AbortSignal.timeout(init.timeoutMs),
        redirect: init.redirect,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        const message = `CLI registry request failed (${response.status})`;
        throw response.status === 429 || response.status >= 500
          ? new Error(message)
          : new RegistryResponseError(message);
      }
      const result = await readBoundedStream(response.body as ReadableStream<Uint8Array>, init.cap);
      if (!result.ok)
        throw new RegistryResponseError('CLI registry response exceeds the byte limit');
      return result.bytes;
    } catch (error) {
      if (error instanceof RegistryResponseError) throw error;
      if (attempt >= REGISTRY_ATTEMPTS)
        throw new Error(`CLI registry download failed after ${attempt} attempts: ${url}`, {
          cause: error,
        });
      await new Promise(resolve => setTimeout(resolve, attempt * 5_000));
    }
  }
}

export async function registryDist(
  version: string,
  request: typeof fetch = fetch
): Promise<{ tarball: string; integrity: string }> {
  const bytes = await fetchRegistryBytes(
    `https://registry.npmjs.org/${CLI_PACKAGE}/${encodeURIComponent(version)}`,
    { cap: 1024 * 1024, timeoutMs: 60_000, redirect: 'follow' },
    request
  );
  return registryMetadataSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).dist;
}

async function downloadFromRegistry(version: string, request: typeof fetch): Promise<Uint8Array> {
  const dist = await registryDist(version, request);
  const bytes = await fetchRegistryBytes(
    dist.tarball,
    { cap: RUNTIME_HARD_MAX_TRANSFER_BYTES, timeoutMs: 5 * 60_000, redirect: 'error' },
    request
  );
  const expected = dist.integrity.slice('sha512-'.length);
  if (createHash('sha512').update(bytes).digest('base64') !== expected)
    throw new Error('CLI registry integrity mismatch');
  const pinned = Object.values(PINNED_CLIS).find(cli => cli.version === version);
  if (pinned && createHash('sha256').update(bytes).digest('hex') !== pinned.sha256)
    throw new Error('Pinned CLI content hash mismatch');
  return bytes;
}

export async function downloadVerified(
  version: string,
  options: { cache?: ArtifactObjectStore; request?: typeof fetch } = {}
): Promise<Uint8Array> {
  const pinned = Object.values(PINNED_CLIS).find(cli => cli.version === version);
  const cache = pinned ? options.cache : undefined;
  if (cache && pinned) {
    const cached = await cache.getBytes(pinnedCliSourceKey(pinned));
    if (cached && createHash('sha256').update(cached).digest('hex') === pinned.sha256)
      return cached;
    if (cached)
      console.warn('Cached pinned CLI tarball does not match its digest; using the registry');
  }
  const bytes = await downloadFromRegistry(version, options.request ?? fetch);
  if (cache && pinned) {
    try {
      await cache.putIfAbsent(pinnedCliSourceKey(pinned), bytes, 'application/gzip');
    } catch (error) {
      console.warn('Pinned CLI tarball was verified but could not be cached', error);
    }
  }
  return bytes;
}
