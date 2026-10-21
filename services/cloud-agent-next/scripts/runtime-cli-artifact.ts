import { createHash } from 'node:crypto';
import { z } from 'zod';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import { RUNTIME_HARD_MAX_TRANSFER_BYTES } from '../src/sandbox-control/runtime-release.js';
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
 * Shared so the integrity rule has one owner across the tooling.
 */

export const CLI_PACKAGE = '@kilocode/cli-linux-x64-baseline';
export const PINNED_CLI_VERSION = KILO_CLI_VERSION;
/** Measured SHA-256 of the pinned tarball; the release baseline. */
export const PINNED_CLI_SHA256 = '2e0de8a1f786de31d27d7f8a1c0d35e468b1ee3af66826c1b5f15658acbb1f79';

const registryMetadataSchema = z.object({
  dist: z.object({
    tarball: z.url().refine(value => new URL(value).protocol === 'https:'),
    integrity: z.string().regex(/^sha512-[A-Za-z0-9+/]+={0,2}$/),
  }),
});

async function readResponse(response: Response, cap: number): Promise<Uint8Array> {
  if (!response.ok || !response.body)
    throw new Error(`CLI registry request failed (${response.status})`);
  const result = await readBoundedStream(response.body as ReadableStream<Uint8Array>, cap);
  if (!result.ok) throw new Error('CLI registry response exceeds the byte limit');
  return result.bytes;
}

export async function registryDist(
  version: string
): Promise<{ tarball: string; integrity: string }> {
  const response = await fetch(
    `https://registry.npmjs.org/${CLI_PACKAGE}/${encodeURIComponent(version)}`,
    { signal: AbortSignal.timeout(60_000) }
  );
  const bytes = await readResponse(response, 1024 * 1024);
  return registryMetadataSchema.parse(JSON.parse(new TextDecoder().decode(bytes))).dist;
}

export async function downloadVerified(version: string): Promise<Uint8Array> {
  const dist = await registryDist(version);
  const response = await fetch(dist.tarball, {
    signal: AbortSignal.timeout(120_000),
    redirect: 'error',
  });
  const bytes = await readResponse(response, RUNTIME_HARD_MAX_TRANSFER_BYTES);
  const expected = dist.integrity.slice('sha512-'.length);
  if (createHash('sha512').update(bytes).digest('base64') !== expected)
    throw new Error('CLI registry integrity mismatch');
  if (
    version === PINNED_CLI_VERSION &&
    createHash('sha256').update(bytes).digest('hex') !== PINNED_CLI_SHA256
  )
    throw new Error('Pinned CLI content hash mismatch');
  return bytes;
}
