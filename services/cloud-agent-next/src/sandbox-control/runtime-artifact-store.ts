/**
 * Immutable, content-addressed runtime artifact publication (plan §6
 * "Publication" and §12 step 3).
 *
 * Objects live under `runtime-artifacts/v1/objects/<sha256>` and are written
 * create-only. A conditional create that wins still re-reads the stored bytes,
 * and a lost race does the same: a Put success alone is not proof, and a
 * differently-sized or differently-hashed existing object must fail. Release
 * evidence goes to `runtime-artifacts/v1/releases/<descriptor-sha256>.json` under
 * the same rule.
 *
 * This module is deliberately free of Node filesystem imports so the Worker can
 * import it. Callers supply a store: either the R2 binding adapter here or a local
 * directory adapter (publish tooling and tests).
 */

export const RUNTIME_ARTIFACT_OBJECT_PREFIX = 'runtime-artifacts/v1/objects/';
export const RUNTIME_ARTIFACT_RELEASE_PREFIX = 'runtime-artifacts/v1/releases/';

export function runtimeArtifactObjectKey(sha256: string): string {
  return `${RUNTIME_ARTIFACT_OBJECT_PREFIX}${sha256}`;
}

export function runtimeArtifactReleaseKey(descriptorSha256: string): string {
  return `${RUNTIME_ARTIFACT_RELEASE_PREFIX}${descriptorSha256}.json`;
}

/** SHA-256 as lowercase hex, using WebCrypto (Workers and Node 20+). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The minimal conditional object surface the store needs. R2 exposes it
 * directly; the local directory adapter used by publish tooling and tests
 * implements the same two methods.
 */
export type ArtifactObjectStore = {
  /** Create-only write. Resolves true when created, false when the key exists. */
  putIfAbsent(key: string, bytes: Uint8Array, contentType: string): Promise<boolean>;
  /** Read the stored bytes, or null when the key is absent. */
  getBytes(key: string): Promise<Uint8Array | null>;
};

export function r2ArtifactObjectStore(bucket: R2Bucket): ArtifactObjectStore {
  return {
    async putIfAbsent(key, bytes, contentType) {
      const stored = await bucket.put(key, bytes, {
        onlyIf: { etagDoesNotMatch: '*' },
        httpMetadata: { contentType },
      });
      // A failed precondition returns null and leaves the existing object intact.
      return stored !== null;
    },
    async getBytes(key) {
      const object = await bucket.get(key);
      return object === null ? null : new Uint8Array(await object.arrayBuffer());
    },
  };
}

/** A stored object's identity after a verified create-only publication. */
export type PublishedArtifact = {
  key: string;
  sha256: string;
  size: number;
  /** True when this call created the object; false when an identical one existed. */
  created: boolean;
};

export class ArtifactByteMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactByteMismatchError';
  }
}

export class ArtifactConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ArtifactConflictError';
  }
}

/**
 * Create-only publication with mandatory re-read verification. The claimed
 * `expectedSha256` must equal the hash of `bytes` before any write, and the bytes
 * that end up stored must match them exactly afterwards, whether this call won the
 * create or found an equal object already present.
 */
export async function publishImmutableObject(
  store: ArtifactObjectStore,
  input: {
    key: string;
    bytes: Uint8Array;
    expectedSha256: string;
    contentType: string;
  }
): Promise<PublishedArtifact> {
  const actual = await sha256Hex(input.bytes);
  if (actual !== input.expectedSha256) {
    throw new ArtifactByteMismatchError(
      `${input.key}: bytes hash ${actual} does not match the declared ${input.expectedSha256}`
    );
  }
  const created = await store.putIfAbsent(input.key, input.bytes, input.contentType);
  const stored = await store.getBytes(input.key);
  if (stored === null) {
    throw new ArtifactConflictError(`${input.key}: object is missing after a create-only write`);
  }
  const storedHash = await sha256Hex(stored);
  if (stored.byteLength !== input.bytes.byteLength || storedHash !== input.expectedSha256) {
    throw new ArtifactConflictError(
      `${input.key}: stored object does not match the expected bytes (size ${stored.byteLength}, hash ${storedHash})`
    );
  }
  return {
    key: input.key,
    sha256: input.expectedSha256,
    size: stored.byteLength,
    created,
  };
}

/** Publish one payload object create-only, verifying the stored bytes. */
export function publishArtifactObject(
  store: ArtifactObjectStore,
  artifact: { sha256: string; bytes: Uint8Array }
): Promise<PublishedArtifact> {
  return publishImmutableObject(store, {
    key: runtimeArtifactObjectKey(artifact.sha256),
    bytes: artifact.bytes,
    expectedSha256: artifact.sha256,
    contentType: 'application/gzip',
  });
}

/** Publish the release-evidence descriptor create-only, verifying stored bytes. */
export function publishReleaseEvidence(
  store: ArtifactObjectStore,
  descriptorBytes: Uint8Array
): Promise<PublishedArtifact> {
  return sha256Hex(descriptorBytes).then(descriptorSha256 =>
    publishImmutableObject(store, {
      key: runtimeArtifactReleaseKey(descriptorSha256),
      bytes: descriptorBytes,
      expectedSha256: descriptorSha256,
      contentType: 'application/json',
    })
  );
}
