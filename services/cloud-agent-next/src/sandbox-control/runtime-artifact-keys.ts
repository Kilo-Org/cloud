export const RUNTIME_ARTIFACT_OBJECT_PREFIX = 'runtime-artifacts/v1/objects/';
export const RUNTIME_ARTIFACT_RELEASE_PREFIX = 'runtime-artifacts/v1/releases/';

export function runtimeArtifactObjectKey(sha256: string): string {
  return `${RUNTIME_ARTIFACT_OBJECT_PREFIX}${sha256}`;
}

export function runtimeArtifactReleaseKey(sha256: string): string {
  return `${RUNTIME_ARTIFACT_RELEASE_PREFIX}${sha256}.json`;
}

export type ArtifactObjectStore = {
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<boolean>;
  getBytes(key: string): Promise<Uint8Array | null>;
};
