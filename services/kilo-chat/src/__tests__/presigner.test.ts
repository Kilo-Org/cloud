import { describe, it, expect } from 'vitest';
import { mintPutUrl, mintGetUrl } from '../util/presigner';

const cfg = {
  accountId: 'test-account',
  bucket: 'kilo-chat-media',
  accessKeyId: 'AKIA-TEST',
  secretAccessKey: 'SECRET-TEST',
};

describe('mintPutUrl', () => {
  it('returns URL pointing at R2 S3 endpoint', async () => {
    const { url, headers } = await mintPutUrl({
      ...cfg,
      key: 'attachments/c/u/a',
      contentType: 'image/png',
      expiresSeconds: 900,
    });
    expect(url).toContain(
      'https://test-account.r2.cloudflarestorage.com/kilo-chat-media/attachments/c/u/a'
    );
    expect(url).toContain('X-Amz-Expires=900');
    expect(url).toContain('X-Amz-Signature=');
    expect(url).toContain('X-Amz-Algorithm=AWS4-HMAC-SHA256');
    expect(headers['Content-Type']).toBe('image/png');
  });

  it('signs Content-Type into the signed headers', async () => {
    const { url } = await mintPutUrl({
      ...cfg,
      key: 'k',
      contentType: 'image/jpeg',
      expiresSeconds: 60,
    });
    expect(decodeURIComponent(url)).toContain('content-type');
  });
});

describe('mintGetUrl', () => {
  it('returns URL pointing at R2 S3 endpoint with expiry', async () => {
    const { url } = await mintGetUrl({
      ...cfg,
      key: 'attachments/c/u/a',
      expiresSeconds: 3600,
    });
    expect(url).toContain(
      'https://test-account.r2.cloudflarestorage.com/kilo-chat-media/attachments/c/u/a'
    );
    expect(url).toContain('X-Amz-Expires=3600');
  });

  it('embeds content-disposition override for download forcing', async () => {
    const { url } = await mintGetUrl({
      ...cfg,
      key: 'k',
      expiresSeconds: 60,
      responseContentDisposition: 'attachment; filename="hello.html"',
    });
    expect(decodeURIComponent(url)).toContain('response-content-disposition=attachment');
  });
});
