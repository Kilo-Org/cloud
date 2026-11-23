import { describe, expect, it, vi } from 'vitest';
import { AwsRequestError } from '@kilocode/worker-utils/aws-client';
import { createAwsObjectStore } from './object-store.js';

const config = {
  credentials: {
    accessKeyId: 'ASIATEST000000000000',
    secretAccessKey: 'test-secret',
    sessionToken: 'test-token',
  },
  region: 'us-east-1',
  bucket: 'customer-artifacts',
};
const key = 'kilo/archives/environment/build/allocation.tar';
const digest = 'a'.repeat(64);
const checksum = Buffer.from(digest, 'hex').toString('base64');
describe('immutable archive storage capabilities', () => {
  it('binds the checksum and first-write precondition into the upload signature', async () => {
    const result = await createAwsObjectStore(config).prepareArchiveUpload(key, digest, 600);
    const url = new URL(result.url);
    expect(url.pathname).toBe('/' + key);
    expect(url.searchParams.get('X-Amz-Expires')).toBe('600');
    const signed = url.searchParams.get('X-Amz-SignedHeaders')?.split(';');
    expect(signed).toContain('if-none-match');
    expect(signed).toContain('x-amz-checksum-sha256');
    expect(signed).toContain('content-type');
    expect(result.headers).toEqual({
      'content-type': 'application/x-tar',
      'if-none-match': '*',
      'x-amz-checksum-sha256': checksum,
    });
    expect(result.headers).not.toHaveProperty('authorization');
    expect(result.headers).not.toHaveProperty('x-amz-security-token');
    await expect(
      createAwsObjectStore(config).prepareArchiveUpload(
        'kilo/proxy/private/material.json',
        digest,
        600
      )
    ).rejects.toThrow('Invalid AWS archive key');
  });
  it('reads the server checksum and size, and distinguishes missing data from denied access', async () => {
    const fetch = vi.fn(async (request: Request) => {
      expect(request.method).toBe('HEAD');
      expect(request.headers.get('x-amz-checksum-mode')).toBe('ENABLED');
      return new Response(null, {
        headers: { 'content-length': '1234', 'x-amz-checksum-sha256': checksum },
      });
    });
    expect(await createAwsObjectStore({ ...config, fetch }).inspectArchive(key)).toEqual({
      size: 1234,
      sha256: digest,
    });
    expect(
      await createAwsObjectStore({
        ...config,
        fetch: async () => new Response(null, { status: 404 }),
      }).inspectArchive(key)
    ).toBeNull();
    await expect(
      createAwsObjectStore({
        ...config,
        fetch: async () => new Response(null, { status: 403 }),
      }).inspectArchive(key)
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      createAwsObjectStore({ ...config, fetch: async () => new Response(null) }).inspectArchive(key)
    ).rejects.toBeInstanceOf(AwsRequestError);
  });
});
