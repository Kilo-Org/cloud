import { it, expect } from 'vitest';
import { remoteArtifactStore } from './runtime-publish-store.js';
const store = (code: string) =>
  remoteArtifactStore({
    accountId: 'a'.repeat(32),
    bucket: 'runtime-test',
    accessKeyId: 'fixture-key',
    secretAccessKey: 'fixture-secret',
    request: async () => new Response('<Error><Code>' + code + '</Code></Error>', { status: 404 }),
  });
it('a missing bucket fails instead of waiting for a missing handoff', async () => {
  await expect(
    store('NoSuchBucket').getBytes('runtime-artifacts/v1/handoffs/' + 'b'.repeat(40) + '.json')
  ).rejects.toThrow('bucket does not exist');
});
it('a missing key still means publication can be pending', async () => {
  expect(
    await store('NoSuchKey').getBytes('runtime-artifacts/v1/handoffs/' + 'b'.repeat(40) + '.json')
  ).toBeNull();
});
