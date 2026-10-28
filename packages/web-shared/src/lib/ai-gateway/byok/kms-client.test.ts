import { afterEach, beforeEach, describe, expect, jest, test } from '@jest/globals';
import { randomBytes } from 'crypto';
import {
  decryptByokEnvelope,
  encryptByokForStorage,
  getByokKmsClientConfig,
  type ByokKmsContext,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';

const context: ByokKmsContext = {
  key_id: 'key-1',
  owner_type: 'user',
  owner_id: 'user-1',
  provider_id: 'anthropic',
};
const actorUserId = 'user-1';

type Call = { url: URL; init: RequestInit };

function installFakeKms() {
  const calls: Call[] = [];
  const dataKeys = new Map<string, { dataKey: string; context: ByokKmsContext }>();
  const fakeFetch = jest.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const target = new URL(String(url));
    calls.push({ url: target, init: init ?? {} });
    const body = JSON.parse(String(init?.body));
    if (target.pathname === '/data-key') {
      const dataKey = randomBytes(32).toString('base64');
      const wrapped = `wrapped-${dataKeys.size}`;
      dataKeys.set(wrapped, {
        dataKey,
        context: {
          key_id: body.key_id,
          owner_type: body.owner_type,
          owner_id: body.owner_id,
          provider_id: body.provider_id,
        },
      });
      return Response.json({
        data_key: dataKey,
        wrapped_dek: wrapped,
        kms_key_id: 'alias/test',
        kms_key_version: '1',
      });
    }
    const entry = dataKeys.get(body.wrapped_dek ?? '');
    const requestContext = {
      key_id: body.key_id,
      owner_type: body.owner_type,
      owner_id: body.owner_id,
      provider_id: body.provider_id,
    };
    if (!entry || JSON.stringify(entry.context) !== JSON.stringify(requestContext)) {
      return new Response('{}', { status: 400 });
    }
    return Response.json({ data_key: entry.dataKey });
  });
  global.fetch = fakeFetch as unknown as typeof fetch;
  return { calls, fakeFetch };
}

const originalFetch = global.fetch;
const envKeys = ['BYOK_KMS_SERVICE_URL', 'BYOK_KMS_SERVICE_TOKEN'] as const;
const originalEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));

beforeEach(() => {
  process.env.BYOK_KMS_SERVICE_URL = 'http://kms.test/';
  process.env.BYOK_KMS_SERVICE_TOKEN = 'token-1';
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
    await expect(
      encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
    ).resolves.toBeNull();
    expect(fakeFetch).not.toHaveBeenCalled();
  });

  test('requires a token when the service URL is set', () => {
    delete process.env.BYOK_KMS_SERVICE_TOKEN;
    expect(() => getByokKmsClientConfig()).toThrow('BYOK_KMS_SERVICE_TOKEN');
  });

  test('creates a data key with identifiers and builds the envelope locally', async () => {
    const { calls } = installFakeKms();

    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });

    expect(calls).toHaveLength(1);
    expect(calls[0].url.href).toBe('http://kms.test/data-key');
    expect(calls[0].init.method).toBe('POST');
    expect(calls[0].init.headers).toMatchObject({
      authorization: 'Bearer token-1',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      ...context,
      actor_user_id: 'user-1',
    });
    expect(String(calls[0].init.body)).not.toContain('sk-secret');
    expect(envelope).toMatchObject({
      wrapped_dek: 'wrapped-0',
      kms_key_id: 'alias/test',
      kms_key_version: '1',
      algorithm: 'aes-256-gcm',
      envelope_version: 1,
    });
    expect(JSON.stringify(envelope)).not.toContain('sk-secret');
  });

  test('retrieves the data key with the full context and decrypts locally', async () => {
    const { calls } = installFakeKms();
    const orgContext: ByokKmsContext = {
      key_id: 'key-2',
      owner_type: 'organization',
      owner_id: 'org-1',
      provider_id: 'anthropic',
    };
    const envelope = await encryptByokForStorage({
      apiKey: 'sk-secret',
      context: orgContext,
      actorUserId,
    });
    if (!envelope) throw new Error('expected envelope');

    await expect(decryptByokEnvelope(envelope, orgContext)).resolves.toBe('sk-secret');

    expect(calls[1].url.href).toBe('http://kms.test/decrypt');
    expect(calls[1].url.search).toBe('');
    expect(calls[1].init.method).toBe('POST');
    expect(calls[1].init.headers).toMatchObject({
      authorization: 'Bearer token-1',
      'content-type': 'application/json',
    });
    expect(JSON.parse(String(calls[1].init.body))).toEqual({
      ...orgContext,
      wrapped_dek: envelope.wrapped_dek,
      kms_key_id: envelope.kms_key_id,
      kms_key_version: envelope.kms_key_version,
    });
  });

  test('never sends the BYOK key or its envelope ciphertext to the service', async () => {
    const { calls } = installFakeKms();
    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });
    if (!envelope) throw new Error('expected envelope');
    await decryptByokEnvelope(envelope, context);

    for (const call of calls) {
      const sent = `${call.url.href}${String(call.init.body ?? '')}`;
      expect(sent).not.toContain('sk-secret');
      expect(sent).not.toContain(envelope.encrypted_data.data);
    }
  });

  test('fails to decrypt with a mismatched context', async () => {
    installFakeKms();
    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });
    if (!envelope) throw new Error('expected envelope');

    await expect(
      decryptByokEnvelope(envelope, { ...context, provider_id: 'openai' })
    ).rejects.toThrow('status 400');
  });

  test('fails to decrypt when the key id differs from the one the data key was created for', async () => {
    installFakeKms();
    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });
    if (!envelope) throw new Error('expected envelope');

    await expect(decryptByokEnvelope(envelope, { ...context, key_id: 'key-9' })).rejects.toThrow(
      'status 400'
    );
  });

  test('rejects a malformed create response', async () => {
    global.fetch = jest.fn(async () =>
      Response.json({ wrapped_dek: 'x' })
    ) as unknown as typeof fetch;
    await expect(
      encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
    ).rejects.toThrow();
  });

  test('rejects a data key that is not 32 bytes', async () => {
    global.fetch = jest.fn(async () =>
      Response.json({
        data_key: Buffer.from('short').toString('base64'),
        wrapped_dek: 'x',
        kms_key_id: 'alias/test',
        kms_key_version: '1',
      })
    ) as unknown as typeof fetch;
    await expect(
      encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
    ).rejects.toThrow('32 bytes');
  });

  test('fails on non-2xx and passes an abort signal', async () => {
    const fetchMock = jest.fn(async () => new Response('nope', { status: 503 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
    ).rejects.toThrow('503');
    const init = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].signal).toBeInstanceOf(AbortSignal);
  });

  test('envelope decrypt fails when the service is not configured', async () => {
    installFakeKms();
    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });
    if (!envelope) throw new Error('expected envelope');
    delete process.env.BYOK_KMS_SERVICE_URL;

    await expect(decryptByokEnvelope(envelope, context)).rejects.toThrow('BYOK_KMS_SERVICE_URL');
  });

  test('stored envelope is decryptable with the data key returned by the service', async () => {
    const { fakeFetch } = installFakeKms();
    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });
    if (!envelope) throw new Error('expected envelope');

    const response = await fakeFetch('http://kms.test/decrypt', {
      method: 'POST',
      body: JSON.stringify({
        ...context,
        wrapped_dek: envelope.wrapped_dek,
        kms_key_id: envelope.kms_key_id,
        kms_key_version: envelope.kms_key_version,
      }),
    });
    const { data_key } = (await response.json()) as { data_key: string };
    expect(decryptApiKey(envelope.encrypted_data, data_key)).toBe('sk-secret');
  });
});
