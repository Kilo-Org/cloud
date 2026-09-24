import { generateKeyPairSync } from 'node:crypto';
import { decryptSecrets, encryptKeyedEnvelope, parseKeyedEnvelope } from '@kilocode/encryption';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import {
  fetchByocE2BCredential,
  fetchByocE2BEnrollment,
  resolveByocE2BApiKey,
} from './e2b-credential-resolver.js';

const keys = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});
const scheme = 'byoc-e2b-credential-rsa-aes-256-gcm';
const apiKey = 'test-customer-api-key';
const identity = {
  organizationId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
};
const env = {
  KILOCODE_BACKEND_BASE_URL: 'https://backend.example.test',
  AGENT_ENV_VARS_PRIVATE_KEY: keys.privateKey,
  INTERNAL_API_SECRET_PROD: { get: async () => 'internal-secret' },
} as Env;

function envelope(key = apiKey) {
  return parseKeyedEnvelope(
    encryptKeyedEnvelope(
      key,
      scheme,
      { keyId: 'agent-env-vars-v1', publicKeyPem: keys.publicKey },
      `byoc-e2b-credential:v1:${identity.organizationId}:${identity.credentialId}`
    ),
    scheme
  );
}

function status(overrides: Record<string, unknown> = {}) {
  return {
    ...identity,
    consentVersion: 'e2b-direct-v1',
    consentedAt: '2026-09-03T00:00:00.000Z',
    validatedAt: '2026-09-03T00:00:00.000Z',
    createdAt: '2026-09-03T00:00:00.000Z',
    ...overrides,
  };
}

function credential(overrides: Record<string, unknown> = {}) {
  return { ...status(), apiKeyEncrypted: envelope(), ...overrides };
}

function stubResponse(data: unknown) {
  const fetchMock = vi.fn(async () => Response.json(data));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('E2B credential resolution', () => {
  it('decrypts only the exact organization and immutable connection envelope', async () => {
    const fetchMock = stubResponse(credential());
    await expect(resolveByocE2BApiKey(env, identity)).resolves.toBe(apiKey);
    expect(fetchMock).toHaveBeenCalledWith(
      `https://backend.example.test/api/internal/byoc/e2b-credentials/${identity.credentialId}?organizationId=${identity.organizationId}`,
      expect.objectContaining({
        method: 'GET',
        headers: { 'x-internal-api-key': 'internal-secret' },
        cache: 'no-store',
        redirect: 'manual',
        signal: expect.any(AbortSignal),
      })
    );
  });

  it('resolves again on each operation and fails after removal without using a cached key', async () => {
    const fetchMock = stubResponse(credential());
    await expect(resolveByocE2BApiKey(env, identity)).resolves.toBe(apiKey);
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    await expect(resolveByocE2BApiKey(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_credential_missing',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it.each(['organizationId', 'credentialId'])('rejects a mismatched %s response', async field => {
    stubResponse(credential({ [field]: '33333333-3333-4333-8333-333333333333' }));
    await expect(fetchByocE2BCredential(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_credential_invalid',
    });
  });

  it.each(['organizationId', 'credentialId'])(
    'rejects ciphertext replay with another %s',
    async field => {
      const replayIdentity = { ...identity, [field]: '33333333-3333-4333-8333-333333333333' };
      stubResponse(credential(replayIdentity));
      await expect(resolveByocE2BApiKey(env, replayIdentity)).rejects.toMatchObject({
        code: 'byoc_e2b_credential_invalid',
      });
    }
  );

  it('does not allow the ordinary secret decryption path to decrypt a copied credential', () => {
    expect(() => decryptSecrets({ KEY: envelope().ciphertext }, keys.privateKey)).toThrow();
  });

  it.each([
    { consentVersion: undefined },
    { consentVersion: 'e2b-direct-v0' },
    { consentedAt: undefined },
    { consentedAt: 'not-a-date' },
  ])('rejects missing or invalid direct-token consent: %j', async overrides => {
    stubResponse(credential(overrides));
    await expect(resolveByocE2BApiKey(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_consent_missing',
    });
  });

  it.each([
    { scheme: 'foreign-envelope' },
    { keyId: 'unknown-key' },
    { version: 2 },
    { ciphertext: { encryptedData: '' } },
  ])('rejects a malformed or foreign envelope: %j', async overrides => {
    stubResponse(credential({ apiKeyEncrypted: { ...envelope(), ...overrides } }));
    await expect(fetchByocE2BCredential(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_credential_invalid',
    });
  });

  it('rejects a blank decrypted key instead of allowing SDK account fallback', async () => {
    stubResponse(credential({ apiKeyEncrypted: envelope('   ') }));
    await expect(resolveByocE2BApiKey(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_credential_invalid',
    });
  });

  it('rejects malformed identity before fetching', async () => {
    const fetchMock = stubResponse(credential());
    await expect(
      resolveByocE2BApiKey(env, { ...identity, credentialId: '' })
    ).rejects.toMatchObject({
      code: 'byoc_e2b_credential_invalid',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sanitizes transport errors without retaining credential-bearing causes', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error(apiKey)));
    await expect(resolveByocE2BApiKey(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_unavailable',
      message: expect.not.stringContaining(apiKey),
    });
  });

  it.each([301, 302, 307, 308, 401, 403, 429, 500, 503])(
    'does not treat HTTP %s as a missing resource',
    async httpStatus => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue(new Response(apiKey, { status: httpStatus }))
      );
      await expect(resolveByocE2BApiKey(env, identity)).rejects.toMatchObject({
        code: 'byoc_e2b_unavailable',
        message: expect.not.stringContaining(apiKey),
      });
    }
  );

  it('bounds the internal response size', async () => {
    stubResponse({ ...credential(), extra: 'x'.repeat(40 * 1024) });
    await expect(resolveByocE2BApiKey(env, identity)).rejects.toMatchObject({
      code: 'byoc_e2b_unavailable',
    });
  });
});

describe('E2B enrollment lookup', () => {
  it('returns only consented status and strips any unexpected ciphertext', async () => {
    const fetchMock = stubResponse(credential());
    await expect(fetchByocE2BEnrollment(env, identity.organizationId)).resolves.toEqual(status());
    expect(fetchMock).toHaveBeenCalledWith(
      `https://backend.example.test/api/internal/byoc/e2b-credentials/organization/${identity.organizationId}`,
      expect.any(Object)
    );
  });

  it('rejects a foreign organization', async () => {
    stubResponse(status({ organizationId: '33333333-3333-4333-8333-333333333333' }));
    await expect(fetchByocE2BEnrollment(env, identity.organizationId)).rejects.toMatchObject({
      code: 'byoc_e2b_credential_invalid',
    });
  });
});
