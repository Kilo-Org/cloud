import { createHash } from 'node:crypto';
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

export async function registryDist(
  version: string
): Promise<{ tarball: string; integrity: string }> {
  const response = await fetch(`https://registry.npmjs.org/${CLI_PACKAGE}/${version}`);
  if (!response.ok) throw new Error(`registry lookup failed for ${version}: ${response.status}`);
  const metadata: { dist: { tarball: string; integrity: string } } = await response.json();
  return metadata.dist;
}

/** Download a CLI tarball and verify the registry's sha512 integrity value. */
export async function downloadVerified(version: string): Promise<Uint8Array> {
  const dist = await registryDist(version);
  const response = await fetch(dist.tarball);
  if (!response.ok) throw new Error(`tarball download failed: ${response.status}`);
  const bytes = new Uint8Array(await response.arrayBuffer());
  const [algorithm, expected] = dist.integrity.split('-');
  if (algorithm !== 'sha512') throw new Error(`unexpected integrity algorithm ${algorithm}`);
  if (createHash('sha512').update(bytes).digest('base64') !== expected) {
    throw new Error(`registry integrity mismatch for ${version}`);
  }
  return bytes;
}
