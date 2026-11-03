import { ProviderCreationError } from './provider.js';
import { readBoundedStream } from '@kilocode/worker-utils/bounded-stream-reader';
import {
  parseRuntimeRelease,
  RUNTIME_DESCRIPTOR_MAX_BYTES,
  SHA256_PATTERN,
  type RuntimeReleaseDescriptor,
} from './runtime-release.js';
import { runtimeArtifactObjectKey, runtimeArtifactReleaseKey } from './runtime-artifact-keys.js';

export type RuntimeArtifactReader = {
  head(key: string): Promise<{ size: number } | null>;
  get?(key: string): Promise<{ size: number; body: ReadableStream<Uint8Array> } | null>;
};

async function readDescriptor(reference: string, reader: RuntimeArtifactReader): Promise<string> {
  // Existing allocations can retain the original inline descriptor format.
  if (!SHA256_PATTERN.test(reference)) return reference;
  if (!reader.get) throw new ProviderCreationError('invalid_configuration');
  const object = await reader.get(runtimeArtifactReleaseKey(reference));
  if (!object) throw new ProviderCreationError('invalid_configuration');
  if (object.size > RUNTIME_DESCRIPTOR_MAX_BYTES) {
    await object.body.cancel().catch(() => {});
    throw new ProviderCreationError('invalid_configuration');
  }
  const result = await readBoundedStream(object.body, RUNTIME_DESCRIPTOR_MAX_BYTES);
  if (!result.ok) throw new ProviderCreationError('invalid_configuration');
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new Uint8Array(result.bytes).buffer)
  );
  const hash = Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== reference) throw new ProviderCreationError('invalid_configuration');
  return new TextDecoder().decode(result.bytes);
}

/** Descriptor and payload checks precede provider work. Storage errors remain transient. */
export async function loadRuntimeRelease(
  descriptor: string,
  reader: RuntimeArtifactReader | undefined
): Promise<RuntimeReleaseDescriptor> {
  if (!reader) throw new ProviderCreationError('invalid_configuration');
  const contents = await readDescriptor(descriptor, reader);
  let release: RuntimeReleaseDescriptor;
  try {
    release = parseRuntimeRelease(contents);
  } catch {
    throw new ProviderCreationError('invalid_configuration');
  }
  for (const artifact of release.artifacts) {
    const object = await reader.head(runtimeArtifactObjectKey(artifact.sha256));
    if (object === null || object.size !== artifact.transferBytes)
      throw new ProviderCreationError('invalid_configuration');
  }
  return release;
}
