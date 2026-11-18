import { beforeEach } from 'vitest';

let bucket: R2Bucket | undefined;

// Imported lazily: a top-level `cloudflare:test` import here loads the Worker
// before test files register their `vi.mock` factories.
beforeEach(async () => {
  const [{ env }, { runtimeArtifactObjectKey }, { FAKE_DOWNLOADED_RUNTIME_ENV }] =
    await Promise.all([
      import('cloudflare:test'),
      import('../../../src/sandbox-control/runtime-artifact-keys.js'),
      import('./fake-credentials.js'),
    ]);
  bucket ??= env.RUNTIME_RELEASE_BUCKET;
  if (!bucket) throw new Error('Missing test runtime R2 binding');
  Object.assign(env, FAKE_DOWNLOADED_RUNTIME_ENV, { RUNTIME_RELEASE_BUCKET: bucket });
  for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
    await bucket.put(runtimeArtifactObjectKey(hash), new Uint8Array([1]));
  }
});
