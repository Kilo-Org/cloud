import { describe, expect, it } from 'vitest';
import { createR2Client } from './r2-client';

describe('R2 presigned downloads', () => {
  it('signs one object for five minutes with attachment disposition', async () => {
    const client = createR2Client({
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      endpoint: 'https://account.r2.cloudflarestorage.com',
    });

    const signed = new URL(
      await client.getSignedURL('exports', 'exports/id/kilo-data-export.jsonl.gz', 300, {
        responseContentDisposition: 'attachment; filename="kilo-data-export.jsonl.gz"',
      })
    );

    expect(signed.pathname).toBe('/exports/exports/id/kilo-data-export.jsonl.gz');
    expect(signed.searchParams.get('X-Amz-Expires')).toBe('300');
    expect(signed.searchParams.get('response-content-disposition')).toBe(
      'attachment; filename="kilo-data-export.jsonl.gz"'
    );
    expect(signed.searchParams.get('response-content-type')).toBeNull();
    expect(signed.searchParams.get('X-Amz-Signature')).toMatch(/^[a-f0-9]{64}$/);
  });

  it('overrides the response content type when requested', async () => {
    const client = createR2Client({
      accessKeyId: 'test-access-key',
      secretAccessKey: 'test-secret-key',
      endpoint: 'https://account.r2.cloudflarestorage.com',
    });

    const signed = new URL(
      await client.getSignedURL('artifacts', 'sandbox/object', 300, {
        responseContentDisposition: "attachment; filename*=UTF-8''report.html",
        responseContentType: 'application/octet-stream',
      })
    );

    expect(signed.searchParams.get('response-content-disposition')).toBe(
      "attachment; filename*=UTF-8''report.html"
    );
    expect(signed.searchParams.get('response-content-type')).toBe('application/octet-stream');
  });
});
