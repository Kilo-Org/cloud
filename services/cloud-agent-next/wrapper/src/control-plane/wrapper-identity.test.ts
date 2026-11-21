import { describe, expect, it, vi } from 'bun:test';
import { createSandboxTransferClient } from '../control/sandbox-transfer-client.js';
import { transferUrlForWrapperInstance } from './wrapper-identity.js';

const launchUrl = 'https://worker.example/sandbox-transfer/sandbox-1/allocation-1/launch-id';
const processId = '0fce125c-54a3-4143-b503-b7775c4d2135';

describe('wrapper transfer identity', () => {
  it('rewrites the launch identity segment to the current process identity', () => {
    expect(transferUrlForWrapperInstance(launchUrl, processId)).toBe(
      `https://worker.example/sandbox-transfer/sandbox-1/allocation-1/${processId}`
    );
  });

  it('preserves the sandbox and allocation and tolerates a trailing slash', () => {
    expect(transferUrlForWrapperInstance(`${launchUrl}/`, processId)).toBe(
      `https://worker.example/sandbox-transfer/sandbox-1/allocation-1/${processId}`
    );
  });

  it('uses the current process path and a renewed grant together', async () => {
    const renewGrant = vi
      .fn()
      .mockResolvedValue({ grant: 'current-grant', expiresAt: Date.now() + 1000 });
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const subject = createSandboxTransferClient({
      baseUrl: `${transferUrlForWrapperInstance(launchUrl, processId)}/artifacts`,
      renewGrant,
      fetch: (url, init) => {
        calls.push({ url, init });
        return Promise.resolve(new Response(null, { status: 204 }));
      },
    });
    try {
      subject.setConnected(true);
      expect(
        await subject.put('objects?path=report.txt', {
          body: new Uint8Array([1]),
        })
      ).toEqual({ status: 'ok', statusCode: 204 });
      expect(calls[0]?.url).toBe(
        `https://worker.example/sandbox-transfer/sandbox-1/allocation-1/${processId}/artifacts/objects?path=report.txt`
      );
      expect(new Headers(calls[0]?.init.headers).get('Authorization')).toBe('Bearer current-grant');
    } finally {
      subject.stop();
    }
  });
});
