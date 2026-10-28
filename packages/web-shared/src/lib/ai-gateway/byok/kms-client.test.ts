import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { compactDecrypt } from 'jose';
import { randomBytes } from 'crypto';
import {
  decryptByokEnvelope,
  encryptByokForStorage,
  getByokKmsClientConfig,
  type ByokKmsContext,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { encryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';

const transportKey = randomBytes(32);
const context: ByokKmsContext = {
  owner_type: 'user',
  owner_id: 'user-1',
  provider_id: 'anthropic',
};

type Call = { url: string; init: RequestInit };

function installFakeKms() {
  const calls: Call[] = [];
  const deks = new Map<string, { dek: string; context: ByokKmsContext }>();
  const fakeFetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    calls.push({ url: target, init: init ?? {} });
    const body = JSON.parse(String(init?.body));
    if (target.endsWith('/encrypt')) {
      const { plaintext, protectedHeader } = await compactDecrypt(body.jwe, transportKey);
      const dek = randomBytes(32).toString('base64');
      const wrapped = `wrapped-${deks.size}`;
      const { v: _v, alg: _alg, enc: _enc, ...ctx } = protectedHeader;
      deks.set(wrapped, { dek, context: ctx as ByokKmsContext });
      return Response.json({
        encrypted_data: encryptApiKey(new TextDecoder().decode(plaintext), dek),
        wrapped_dek: wrapped,
        kms_key_id: 'alias/test',
        kms_key_version: '1',
        algorithm: 'aes-256-gcm',
        envelope_version: 1,
      });
    }
    const entry = deks.get(body.wrapped_dek);
    if (!entry || JSON.stringify(entry.context) !== JSON.stringify(body.context)) {
      return new Response('{}', { status: 400 });
    }
    return Response.json({ dek: entry.dek });
  });
  global.fetch = fakeFetch as unknown as typeof fetch;
  return { calls, fakeFetch };
}

const originalFetch = global.fetch;
const envKeys = [
  'BYOK_KMS_SERVICE_URL',
  'BYOK_KMS_SERVICE_TOKEN',
  'BYOK_KMS_TRANSPORT_ENCRYPTION_KEY',
] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

beforeEach(() => {
  process.env.BYOK_KMS_SERVICE_URL = 'http://kms.test/';
  process.env.BYOK_KMS_SERVICE_TOKEN = 'token-1';
  process.env.BYOK_KMS_TRANSPORT_ENCRYPTION_KEY = transportKey.toString('base64');
});

afterEach(() => {
  global.fetch = originalFetch;
  for (const key of envKeys) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

describe('byok kms client', () => {
  test('returns null when the service is not configured', async () => {
    delete process.env.BYOK_KMS_SERVICE_URL;
    const { fakeFetch } = installFakeKms();

    expect(getByokKmsClientConfig()).toBeNull();
    await expect(encryptByokForStorage({ apiKey: 'sk-test', context })).resolves.toBeNull();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test('requires a token when the service URL is set', () => {
    delete process.env.BYOK_KMS_SERVICE_TOKEN;
    expect(() => getByokKmsClientConfig()).toThrow('BYOK_KMS_SERVICE_TOKEN');
  });

  test('round-trips through encrypt and decrypt with the expected request shape', async () => {
    const { calls } = installFakeKms();

    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context });
    expect(envelope).toMatchObject({
      kms_key_id: 'alias/test',
      algorithm: 'aes-256-gcm',
      envelope_version: 1,
    });
    expect(calls[0].url).toBe('http://kms.test/encrypt');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      authorization: 'Bearer token-1',
      'content-type': 'application/json',
    });
    expect(Object.keys(JSON.parse(String(calls[0].init.body)))).toEqual(['jwe']);
    expect(JSON.stringify(calls[0].init.body)).not.toContain('sk-secret');

    if (!envelope) throw new Error('expected envelope');
    await expect(decryptByokEnvelope(envelope, context)).resolves.toBe('sk-secret');
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      wrapped_dek: envelope.wrapped_dek,
      kms_key_id: envelope.kms_key_id,
      kms_key_version: envelope.kms_key_version,
      context,
    });
  });

  test('fails to decrypt with a mismatched context', async () => {
    installFakeKms();
    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context });
    if (!envelope) throw new Error('expected envelope');

    await expect(
      decryptByokEnvelope(envelope, { ...context, provider_id: 'openai' })
    ).rejects.toThrow('status 400');
  });

  test('rejects a malformed encrypt response', async () => {
    global.fetch = jest.fn(async () =>
      Response.json({ wrapped_dek: 'x' })
    ) as unknown as typeof fetch;
    await expect(encryptByokForStorage({ apiKey: 'sk-test', context })).rejects.toThrow();
  });

  test('fails on non-2xx and passes an abort signal', async () => {
    const fetchMock = jest.fn(async () => new Response('nope', { status: 503 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(encryptByokForStorage({ apiKey: 'sk-test', context })).rejects.toThrow('503');
    const init = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].signal).toBeInstanceOf(AbortSignal);
  });

  test('envelope decrypt fails when the service is not configured', async () => {
    installFakeKms();
    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context });
    if (!envelope) throw new Error('expected envelope');
    delete process.env.BYOK_KMS_SERVICE_URL;

    await expect(decryptByokEnvelope(envelope, context)).rejects.toThrow('BYOK_KMS_SERVICE_URL');
  });
});
