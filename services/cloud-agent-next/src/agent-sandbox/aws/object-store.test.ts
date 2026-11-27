import { describe, expect, it } from 'vitest';
import { createAwsObjectStore } from './object-store.js';

const credentials = {
  accessKeyId: 'ASIATEST000000000000',
  secretAccessKey: 'test-secret',
  sessionToken: 'test-token',
};
const launchKey =
  'kilo/launch/arn:aws:ec2:us-east-1:123456789012:instance/i-0123456789abcdef0/11111111-1111-4111-8111-111111111111.json';

describe('EC2 object store', () => {
  it('writes only an instance-scoped launch key and prevents replacement', async () => {
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
    await store.putLaunch(launchKey, 'launch');
    for (const key of [
      'proxy/private/ca.key',
      'kilo/launch/../other.json',
      launchKey.replace('us-east-1', 'us-west-2'),
      launchKey.replace('/launch/', '/stopped/'),
    ]) {
      await expect(store.putLaunch(key, 'launch')).rejects.toThrow('Invalid AWS EC2 object key');
    }
  });
});
