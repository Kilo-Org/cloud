import { describe, expect, it } from 'vitest';
import { createAwsObjectStore } from './object-store.js';

const credentials = {
  accessKeyId: 'ASIATEST000000000000',
  secretAccessKey: 'test-secret',
  sessionToken: 'test-token',
};

describe('AWS object store', () => {
  it('prevents launch and archive capabilities from reaching proxy-private material', async () => {
    const store = createAwsObjectStore({
      credentials,
      region: 'us-east-1',
      bucket: 'customer-artifacts',
      fetch: async input => {
        expect(input.method).toBe('PUT');
        expect(input.headers.get('if-none-match')).toBe('*');
        expect(await input.text()).toBe('launch');
        return new Response(null, { status: 200 });
      },
    });
    await store.putLaunch('kilo/launch/allocation-1.json', 'launch');
    for (const key of [
      'proxy/private/ca.key',
      'kilo/launch/../proxy.json',
      'kilo/archives//other.tar.gz',
    ]) {
      await expect(store.downloadUrl(key, 600)).rejects.toThrow('Invalid AWS artifact key');
    }
    await expect(
      store.prepareArchiveUpload('kilo/launch/allocation-1.json', 'a'.repeat(64), 600)
    ).rejects.toThrow('Invalid AWS archive key');
  });
});
