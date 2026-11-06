import { env } from 'cloudflare:test';
import { beforeEach } from 'vitest';
import { runtimeArtifactObjectKey } from '../../../src/sandbox-control/runtime-artifact-keys.js';
import { FAKE_DOWNLOADED_RUNTIME_ENV } from './fake-credentials.js';

const bucket = env.RUNTIME_RELEASE_BUCKET;

beforeEach(async () => {
  if (!bucket) throw new Error('Missing test runtime R2 binding');
  Object.assign(env, FAKE_DOWNLOADED_RUNTIME_ENV, { RUNTIME_RELEASE_BUCKET: bucket });
  for (const hash of ['a'.repeat(64), 'b'.repeat(64)]) {
    await bucket.put(runtimeArtifactObjectKey(hash), new Uint8Array([1]));
  }
});
