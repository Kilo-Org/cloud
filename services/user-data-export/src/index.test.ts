import { describe, expect, it } from 'vitest';
import { __test__ } from './index';

describe('download URL expiration', () => {
  const now = Date.parse('2026-08-09T03:00:00.000Z');

  it('uses five minutes when the export remains available longer', () => {
    expect(__test__.downloadExpiration('2026-08-09T04:00:00.000Z', now)).toEqual({
      expiresIn: 300,
      expiresAt: '2026-08-09T03:05:00.000Z',
    });
  });

  it('does not outlive the export retention deadline', () => {
    expect(__test__.downloadExpiration('2026-08-09T03:01:00.000Z', now)).toEqual({
      expiresIn: 60,
      expiresAt: '2026-08-09T03:01:00.000Z',
    });
    expect(__test__.downloadExpiration('2026-08-09T02:59:59.000Z', now)).toBeNull();
  });
});

describe('internal request parsing', () => {
  it('rejects chunked bodies larger than 16 KiB without relying on content-length', async () => {
    const request = new Request('https://worker.local/internal', {
      method: 'POST',
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('x'.repeat(16_385)));
          controller.close();
        },
      }),
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });

    await expect(__test__.readJson(request)).rejects.toThrow('Request body is too large');
  });
});
