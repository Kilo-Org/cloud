import { afterEach, describe, expect, it, vi } from 'vitest';

import { loadLegalDocument } from './legal-document';

vi.mock('@/lib/config', () => ({ API_BASE_URL: 'https://api.example.com' }));

const originalFetch = globalThis.fetch;

function respondWith(response: Response | Error): void {
  globalThis.fetch = vi.fn(() =>
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response)
  );
}

const signal = new AbortController().signal;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe('loadLegalDocument', () => {
  it('reads the document from the app API', async () => {
    respondWith(Response.json({ html: '<h1>Terms</h1>' }));

    await expect(loadLegalDocument('terms', signal)).resolves.toEqual({
      kind: 'loaded',
      html: '<h1>Terms</h1>',
    });
    expect(globalThis.fetch).toHaveBeenCalledWith('https://api.example.com/api/legal/terms', {
      signal,
    });
  });

  it('treats an unreachable API as retryable', async () => {
    respondWith(new Error('network unavailable'));

    await expect(loadLegalDocument('privacy', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'retryable',
    });
  });

  it('treats a server-side failure as retryable', async () => {
    respondWith(new Response('{}', { status: 502 }));

    await expect(loadLegalDocument('privacy', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'retryable',
    });
  });

  it('treats a document the server does not serve as unavailable', async () => {
    respondWith(new Response('{}', { status: 404 }));

    await expect(loadLegalDocument('privacy', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'unavailable',
    });
  });

  it('treats an unreadable body as retryable', async () => {
    respondWith(new Response('not json', { status: 200 }));

    await expect(loadLegalDocument('terms', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'retryable',
    });
  });

  it('treats an empty document as retryable', async () => {
    respondWith(Response.json({ html: '   ' }));

    await expect(loadLegalDocument('terms', signal)).resolves.toEqual({
      kind: 'failed',
      failure: 'retryable',
    });
  });
});
