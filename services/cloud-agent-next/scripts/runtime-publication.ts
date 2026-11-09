import { createHash } from 'node:crypto';
import type { ArtifactObjectStore } from '../src/sandbox-control/runtime-artifact-keys.js';

export function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export type PublishedArtifact = { key: string; sha256: string; size: number; created: boolean };

export async function publishImmutableObject(
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
