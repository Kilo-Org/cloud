import { readAwsResponseBytes } from './aws-client';
import { describe, expect, it } from 'vitest';
import { assumeAwsRole, createAwsClient, readAwsResponse } from './aws-client';

const credentials = {
  accessKeyId: 'ASIATEST000000000000',
  secretAccessKey: 'test-secret',
  sessionToken: 'test-token',
};

describe('AWS signed transport', () => {
  it('signs the exact body and includes the session token', async () => {
    const client = createAwsClient({
      credentials,
      region: 'us-east-1',
      service: 'ecs',
      fetch: async request => {
        expect(request.headers.get('authorization')).toContain('/us-east-1/ecs/aws4_request');
        expect(request.headers.get('x-amz-security-token')).toBe('test-token');
        expect(await request.text()).toBe('{"clientToken":"intent-1"}');
        expect(request.redirect).toBe('manual');
        return new Response('{}');
      },
    });
    await client.request('https://ecs.us-east-1.amazonaws.com/', {
      method: 'POST',
      body: '{"clientToken":"intent-1"}',
    });
  });

  it('does not retain sensitive AWS bodies or arbitrary transport errors', async () => {
    for (const fetcher of [
      async () =>
        new Response('credential=private-value', {
          status: 403,
          headers: { 'x-amzn-errortype': 'AccessDeniedException' },
        }),
      async () => {
        throw new Error('signed-url=private-value');
      },
    ]) {
      const client = createAwsClient({
        credentials,
        region: 'us-east-1',
        service: 'lambda',
        fetch: fetcher,
      });
      try {
        await client.request('https://lambda.us-east-1.amazonaws.com/');
        throw new Error('expected rejection');
      } catch (error) {
        expect(String(error)).toMatch(/AWS request failed/);
        expect(String(error)).not.toContain('private-value');
      }
    }
  });

  it('rejects an oversized streamed AWS response and cancels its source', async () => {
    let cancelled = false;
    const response = new Response(
      new ReadableStream({
        pull(controller) {
          controller.enqueue(new Uint8Array(1024));
        },
        cancel() {
          cancelled = true;
        },
      })
    );
    await expect(readAwsResponse(response, 512)).rejects.toThrow('ResponseTooLarge');
    expect(cancelled).toBe(true);
  });

  it('assumes an exact customer role with its owner-bound external ID', async () => {
    const result = await assumeAwsRole({
      credentials,
      region: 'us-east-1',
      roleArn: 'arn:aws:iam::123456789012:role/customer',
      externalId: 'owner&external-id',
      fetch: async request => {
        const body = new URLSearchParams(await request.text());
        expect(body.get('RoleArn')).toBe('arn:aws:iam::123456789012:role/customer');
        expect(body.get('ExternalId')).toBe('owner&external-id');
        expect(body.get('DurationSeconds')).toBe('3600');
        return new Response(
          '<AssumeRoleResponse><Credentials><Expiration>2099-01-01T00:00:00Z</Expiration><AccessKeyId>ASIA1234567890123456</AccessKeyId><SecretAccessKey>new/secret+value=</SecretAccessKey><SessionToken>new/token+value=</SessionToken></Credentials></AssumeRoleResponse>'
        );
      },
    });
    expect(result).toEqual({
      accessKeyId: 'ASIA1234567890123456',
      secretAccessKey: 'new/secret+value=',
      sessionToken: 'new/token+value=',
      expiresAt: Date.parse('2099-01-01T00:00:00Z'),
    });
  });

  it('rejects malformed role credentials without returning partial authority', async () => {
    await expect(
      assumeAwsRole({
        credentials,
        region: 'us-east-1',
        roleArn: 'arn:aws:iam::123456789012:role/customer',
        fetch: async () => new Response('<AccessKeyId>ASIA1234567890123456</AccessKeyId>'),
      })
    ).rejects.toThrow('InvalidCredentialsResponse');
  });

  it('signs a short-lived S3 upload without adding AWS credentials to headers', async () => {
    const client = createAwsClient({ credentials, region: 'us-east-1', service: 's3' });
    const url = new URL(
      await client.signedUrl(new URL('https://bucket.s3.us-east-1.amazonaws.com/key'), 'PUT', 600)
    );
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    expect(url.searchParams.has('X-Amz-Signature')).toBe(true);
    await expect(client.signedUrl(url, 'GET', 3601)).rejects.toThrow('Invalid AWS URL lifetime');
  });

  it('forwards the caller abort signal to the fetch and refuses a URL beyond credential expiry', async () => {
    const controller = new AbortController();
    controller.abort();
    const client = createAwsClient({
      credentials: { ...credentials, expiresAt: Date.now() + 60_000 },
      region: 'us-east-1',
      service: 's3',
      fetch: async request => {
        expect(request.signal.aborted).toBe(true);
        return new Response('{}');
      },
    });
    await client.request('https://bucket.s3.us-east-1.amazonaws.com/key', {
      signal: controller.signal,
    });
    await expect(
      client.signedUrl(new URL('https://bucket.s3.us-east-1.amazonaws.com/key'), 'GET', 60)
    ).rejects.toThrow('AWS credentials expire before the signed URL');
  });
});

describe('bounded AWS binary responses', () => {
  it('preserves exact bytes for immutable artifact checksums', async () => {
    const bytes = Uint8Array.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]);
    expect(await readAwsResponseBytes(new Response(bytes))).toEqual(bytes);
    await expect(readAwsResponseBytes(new Response(bytes), 4)).rejects.toMatchObject({
      code: 'ResponseTooLarge',
    });
  });
});
