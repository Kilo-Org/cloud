import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  fetchByocE2BCredential,
  fetchByocE2BEnrollment,
} from '../../src/byoc/e2b-credential-resolver.js';
import type { Env } from '../../src/types.js';

const identity = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
};
const status = {
  ...identity,
  consentVersion: 'e2b-direct-v1',
  consentedAt: '2026-09-03T00:00:00.000Z',
  validatedAt: '2026-09-03T00:00:00.000Z',
  createdAt: '2026-09-03T00:00:00.000Z',
};
const credential = {
  ...status,
  apiKeyEncrypted: {
    scheme: 'byoc-e2b-credential-rsa-aes-256-gcm',
    version: 1,
    keyId: 'agent-env-vars-v1',
    ciphertext: {
      encryptedData: 'fixture-data',
      encryptedDEK: 'fixture-encrypted-key',
      algorithm: 'rsa-aes-256-gcm',
      version: 1,
    },
  },
};
const env = {
  KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test',
  INTERNAL_API_SECRET_PROD: { get: async () => 'fixture-internal-secret' },
} as Env;

afterEach(() => vi.unstubAllGlobals());

describe('E2B internal credential transport in workerd', () => {
  it('constructs supported native requests and consumes the exact consented envelope', async () => {
    expect(navigator.userAgent).toBe('Cloudflare-Workers');
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        const request = new Request(input, init);
        requests.push(request);
        return Response.json(credential);
      })
    );
    await expect(fetchByocE2BCredential(env, identity)).resolves.toEqual(credential);
    await expect(fetchByocE2BEnrollment(env, identity.organizationId)).resolves.toEqual(status);
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.redirect).toBe('manual');
      expect(request.headers.get('x-internal-api-key')).toBe('fixture-internal-secret');
      expect(new URL(request.url).origin).toBe('https://backend.example.test');
    }
    expect(new URL(requests[0].url).searchParams.get('organizationId')).toBe(
      identity.organizationId
    );
  });

  it('rejects a redirect without sending the internal authentication to its target', async () => {
    const requests: Request[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        requests.push(new Request(input, init));
        return new Response(null, {
          status: 307,
          headers: { Location: 'https://foreign.example.test' },
        });
      })
    );
    await expect(fetchByocE2BCredential(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_unavailable',
    });
    expect(requests).toHaveLength(1);
    expect(requests[0].redirect).toBe('manual');
    expect(new URL(requests[0].url).origin).toBe('https://backend.example.test');
  });

  it('bounds streamed internal responses using native Worker byte chunks', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init: RequestInit) => {
        expect(new Request(input, init).redirect).toBe('manual');
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new Uint8Array(20 * 1024));
              controller.enqueue(new Uint8Array(20 * 1024));
              controller.close();
            },
          })
        );
      })
    );
    await expect(fetchByocE2BCredential(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_unavailable',
    });
  });
});
