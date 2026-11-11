import { describe, expect, it, vi } from 'vitest';
import {
  declaredLength,
  mediaType,
  readBoundedBytes,
  streamToBucket,
} from './sandbox-transfer-http.js';

describe('sandbox transfer HTTP helpers', () => {
  it('parses declared lengths and media types strictly', () => {
    expect(declaredLength(undefined)).toBeUndefined();
    expect(declaredLength('0')).toBe(0);
    expect(declaredLength('42')).toBe(42);
    expect(declaredLength('-1')).toBe('invalid');
    expect(declaredLength('1.5')).toBe('invalid');
    expect(mediaType(undefined)).toBeUndefined();
    expect(mediaType('application/json; charset=utf-8')).toBe('application/json');
  });

  it('buffers only up to the byte cap', async () => {
    const request = new Request('http://worker.test', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(await readBoundedBytes(request, 4)).toEqual(new Uint8Array([1, 2, 3, 4]));

    const tooLarge = new Request('http://worker.test', {
      method: 'PUT',
      body: new Uint8Array([1, 2, 3, 4]),
    });
    expect(await readBoundedBytes(tooLarge, 3)).toBeUndefined();
  });

  it('requires a Content-Length before streaming to R2', async () => {
    const put = vi.fn();
    const bucket = { put } as unknown as R2Bucket;
    expect(
      await streamToBucket(
        bucket,
        'key',
        { headers: new Headers(), body: null } as unknown as Request,
        {
          maxBytes: 10,
          sha256: 'a'.repeat(64),
          contentType: 'application/octet-stream',
        }
      )
    ).toEqual({ status: 'missing_length' });
    expect(put).not.toHaveBeenCalled();
  });

  it('rejects invalid and oversized lengths without reading the body', async () => {
    const put = vi.fn();
    const bucket = { put } as unknown as R2Bucket;
    expect(
      await streamToBucket(
        bucket,
        'key',
        new Request('http://worker.test', {
          method: 'PUT',
          headers: { 'Content-Length': 'abc' },
        }),
        { maxBytes: 10, sha256: 'a'.repeat(64), contentType: 'application/octet-stream' }
      )
    ).toEqual({ status: 'invalid_length' });
    expect(
      await streamToBucket(
        bucket,
        'key',
        new Request('http://worker.test', {
          method: 'PUT',
          headers: { 'Content-Length': '11' },
        }),
        { maxBytes: 10, sha256: 'a'.repeat(64), contentType: 'application/octet-stream' }
      )
    ).toEqual({ status: 'too_large' });
    expect(put).not.toHaveBeenCalled();
  });

  it('passes the request stream and hash options straight to R2', async () => {
    const object = { etag: 'etag' };
    const put = vi.fn().mockResolvedValue(object);
    const bucket = { put } as unknown as R2Bucket;
    const request = new Request('http://worker.test', {
      method: 'PUT',
      headers: { 'Content-Length': '256' },
      body: new Uint8Array(256),
    });
    const result = await streamToBucket(bucket, 'objects/key', request, {
      maxBytes: 1024,
      sha256: 'b'.repeat(64),
      contentType: 'application/octet-stream',
    });
    expect(result).toEqual({ status: 'stored', object });
    expect(put).toHaveBeenCalledWith('objects/key', request.body, {
      sha256: 'b'.repeat(64),
      httpMetadata: { contentType: 'application/octet-stream' },
      onlyIf: { etagDoesNotMatch: '*' },
    });
  });

  it('reports storage unavailability', async () => {
    const bucket = {
      put: vi.fn().mockResolvedValue(null),
    } as unknown as R2Bucket;
    const request = new Request('http://worker.test', {
      method: 'PUT',
      headers: { 'Content-Length': '1' },
      body: new Uint8Array([1]),
    });
    expect(
      await streamToBucket(bucket, 'key', request, {
        maxBytes: 10,
        sha256: 'c'.repeat(64),
        contentType: 'application/octet-stream',
      })
    ).toEqual({ status: 'storage_unavailable' });
  });

  it('separates a hash mismatch from other storage failures', async () => {
    const bucket = {
      put: vi
        .fn()
        .mockRejectedValue(
          new Error('The SHA-256 you specified did not match the calculated hash of the data')
        ),
    } as unknown as R2Bucket;
    const request = new Request('http://worker.test', {
      method: 'PUT',
      headers: { 'Content-Length': '1' },
      body: new Uint8Array([1]),
    });
    expect(
      await streamToBucket(bucket, 'key', request, {
        maxBytes: 10,
        sha256: 'd'.repeat(64),
        contentType: 'application/octet-stream',
      })
    ).toEqual({ status: 'hash_mismatch' });
  });
});
