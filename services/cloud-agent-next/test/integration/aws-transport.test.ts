import { describe, expect, it } from 'vitest';
import { AwsRequestError, createAwsClient } from '@kilocode/worker-utils/aws-client';

const credentials = {
  accessKeyId: 'ASIATEST000000000000',
  secretAccessKey: 'test-secret',
};

describe('AWS transport in workerd', () => {
  it('constructs a signed request using the supported redirect mode', async () => {
    let received = false;
    const client = createAwsClient({
      credentials,
      region: 'us-east-1',
      service: 'sts',
      fetch: async request => {
        received = true;
        expect(request.redirect).toBe('manual');
        expect(request.headers.get('authorization')).toContain('/us-east-1/sts/aws4_request');
        return new Response('{}');
      },
    });
    await client.request('https://sts.us-east-1.amazonaws.com/');
    expect(received).toBe(true);
  });

  it('rejects a redirect without sending signed credentials to its target', async () => {
    let calls = 0;
    const client = createAwsClient({
      credentials,
      region: 'us-east-1',
      service: 'sts',
      fetch: async request => {
        calls++;
        expect(request.redirect).toBe('manual');
        return new Response(null, {
          status: 302,
          headers: { location: 'https://other.example/' },
        });
      },
    });
    await expect(client.request('https://sts.us-east-1.amazonaws.com/')).rejects.toEqual(
      new AwsRequestError(302, 'RequestRejected')
    );
    expect(calls).toBe(1);
  });
});
