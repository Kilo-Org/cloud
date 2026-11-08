// jest.mock is hoisted above const declarations, so the store lives inside the factory and the
// tests reach it through jest.requireMock.
jest.mock('@kilocode/web-shared/lib/redis', () => {
  const store = new Map<string, string>();
  return {
    redisClient: {
      store,
      get: jest.fn(async (key: string) => store.get(key) ?? null),
      set: jest.fn(async (key: string, value: string) => {
        store.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (store.delete(key) ? 1 : 0)),
    },
  };
});

import { afterEach, beforeEach, describe, expect, test } from '@jest/globals';
import { randomBytes } from 'crypto';
import {
  createByokDataKey,
  decryptByokEnvelope,
  encryptByokForStorage,
  encryptByokWithDataKey,
  getByokKmsClientConfig,
  KMS_MAX_ATTEMPTS,
} from '@kilocode/web-shared/lib/ai-gateway/byok/kms-client';
import type { ByokKmsContext } from '@kilocode/web-shared/lib/ai-gateway/byok/kms-context';
import { decryptApiKey } from '@kilocode/web-shared/lib/ai-gateway/byok/encryption';
import { BYOK_DATA_KEY_CACHE_TTL_SECONDS } from '@kilocode/web-shared/lib/ai-gateway/byok/data-key-cache';

const mockRedis = jest.requireMock<{
  redisClient: {
    store: Map<string, string>;
    get: jest.Mock;
    set: jest.Mock;
    del: jest.Mock;
  };
}>('@kilocode/web-shared/lib/redis').redisClient;

const context: ByokKmsContext = {
  key_id: 'key-1',
  owner_type: 'user',
  owner_id: 'user-1',
  provider_id: 'anthropic',
};
const actorUserId = 'user-1';

type Call = { url: URL; init: RequestInit };

/**
 * Records the waits the client schedules between attempts, and runs each one at once, so the
 * retry sequence is visible without spending its delay.
 */
function recordRetryWaits() {
  const waits: number[] = [];
  const spy = jest.spyOn(global, 'setTimeout').mockImplementation(((
    callback: () => void,
    ms?: number
  ) => {
    waits.push(ms ?? 0);
    callback();
    return 0;
  }) as unknown as typeof setTimeout);
  return { waits, restore: () => spy.mockRestore() };
}

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
  mockRedis.store.clear();
  mockRedis.get.mockClear();
  mockRedis.set.mockClear();
  mockRedis.del.mockClear();
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

  test('creates a data key before the secret is known and encrypts with it later', async () => {
    const { calls } = installFakeKms();

    const dataKey = await createByokDataKey({ context, actorUserId });
    if (!dataKey) throw new Error('expected data key');
    expect(calls).toHaveLength(1);
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      ...context,
      actor_user_id: 'user-1',
    });

    const envelope = encryptByokWithDataKey('sk-later', dataKey);
    expect(calls).toHaveLength(1);
    expect(envelope.wrapped_dek).toBe(dataKey.wrapped_dek);
    await expect(decryptByokEnvelope(envelope, context)).resolves.toBe('sk-later');
  });

  test('does not create a data key when the service is not configured', async () => {
    delete process.env.BYOK_KMS_SERVICE_URL;
    const { fakeFetch } = installFakeKms();

    await expect(createByokDataKey({ context, actorUserId })).resolves.toBeNull();
    expect(fakeFetch).not.toHaveBeenCalled();
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

  test('fails on a 4xx answer without retrying and passes an abort signal', async () => {
    const fetchMock = jest.fn(async () => new Response('nope', { status: 403 }));
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
    ).rejects.toThrow('status 403');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(init[1].signal).toBeInstanceOf(AbortSignal);
  });

  test('retries a transient 5xx answer and returns the successful result', async () => {
    const dataKey = randomBytes(32).toString('base64');
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 503 });
      if (calls === 2) return new Response('{}', { status: 502 });
      return Response.json({
        data_key: dataKey,
        wrapped_dek: 'wrapped-after-retries',
        kms_key_id: 'alias/test',
        kms_key_version: '1',
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { waits, restore } = recordRetryWaits();

    try {
      const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });

      expect(envelope?.wrapped_dek).toBe('wrapped-after-retries');
      expect(fetchMock).toHaveBeenCalledTimes(KMS_MAX_ATTEMPTS);
      // The base delay grows with the attempt, plus jitter below one base delay.
      expect(waits).toHaveLength(KMS_MAX_ATTEMPTS - 1);
      expect(waits[0]).toBeGreaterThanOrEqual(100);
      expect(waits[0]).toBeLessThan(200);
      expect(waits[1]).toBeGreaterThanOrEqual(200);
      expect(waits[1]).toBeLessThan(300);
    } finally {
      restore();
    }
  });

  test('retries the transient 4xx answers 408 and 429', async () => {
    const dataKey = randomBytes(32).toString('base64');
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 408 });
      if (calls === 2) return new Response('{}', { status: 429 });
      return Response.json({
        data_key: dataKey,
        wrapped_dek: 'wrapped-after-throttling',
        kms_key_id: 'alias/test',
        kms_key_version: '1',
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });

    expect(envelope?.wrapped_dek).toBe('wrapped-after-throttling');
    expect(fetchMock).toHaveBeenCalledTimes(KMS_MAX_ATTEMPTS);
  });

  test('waits for the Retry-After hint before retrying a 429', async () => {
    const dataKey = randomBytes(32).toString('base64');
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls += 1;
      if (calls === 1) return new Response('{}', { status: 429, headers: { 'retry-after': '1' } });
      return Response.json({
        data_key: dataKey,
        wrapped_dek: 'wrapped-after-hint',
        kms_key_id: 'alias/test',
        kms_key_version: '1',
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const { waits, restore } = recordRetryWaits();

    try {
      const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });

      expect(envelope?.wrapped_dek).toBe('wrapped-after-hint');
      expect(fetchMock).toHaveBeenCalledTimes(2);
      // The header asks for one second, which is longer than the base delay for attempt one.
      expect(waits).toEqual([1_000]);
    } finally {
      restore();
    }
  });

  test('fails at once when Retry-After asks for longer than the time budget', async () => {
    const fetchMock = jest.fn(
      async () => new Response('{}', { status: 429, headers: { 'retry-after': '30' } })
    );
    global.fetch = fetchMock as unknown as typeof fetch;
    const { waits, restore } = recordRetryWaits();

    try {
      await expect(
        encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
      ).rejects.toThrow('status 429');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      // The hint reaches past the budget, so the call fails without waiting for it.
      expect(waits).toEqual([]);
    } finally {
      restore();
    }
  });

  test('gives up after the last attempt and throws the final status', async () => {
    const fetchMock = jest.fn(async () => new Response('nope', { status: 503 }));
    global.fetch = fetchMock as unknown as typeof fetch;
    const { waits, restore } = recordRetryWaits();

    try {
      await expect(
        encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
      ).rejects.toThrow('status 503');
      expect(fetchMock).toHaveBeenCalledTimes(KMS_MAX_ATTEMPTS);
      // Two retries are issued and the third failure ends the sequence without a wait.
      expect(waits).toHaveLength(KMS_MAX_ATTEMPTS - 1);
    } finally {
      restore();
    }
  });

  test('retries a timeout and a network failure before returning a data key', async () => {
    const dataKey = randomBytes(32).toString('base64');
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls += 1;
      if (calls === 1) throw new DOMException('The operation timed out.', 'TimeoutError');
      if (calls === 2) throw new TypeError('fetch failed');
      return Response.json({
        data_key: dataKey,
        wrapped_dek: 'wrapped-after-transport-errors',
        kms_key_id: 'alias/test',
        kms_key_version: '1',
      });
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const envelope = await encryptByokForStorage({ apiKey: 'sk-secret', context, actorUserId });

    expect(envelope?.wrapped_dek).toBe('wrapped-after-transport-errors');
    expect(calls).toBe(KMS_MAX_ATTEMPTS);
  });

  test('does not retry a failure that is not a transport error', async () => {
    const fetchMock = jest.fn(async () => {
      throw new Error('malformed request');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(
      encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
    ).rejects.toThrow('malformed request');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test('stops retrying once the time budget is spent', async () => {
    let clock = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    const fetchMock = jest.fn(async () => {
      clock += 60_000;
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
      ).rejects.toThrow('The operation timed out.');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
  });

  test('rethrows the earlier failure instead of retrying with too little budget left', async () => {
    let clock = 1_000;
    const nowSpy = jest.spyOn(Date, 'now').mockImplementation(() => clock);
    let calls = 0;
    const fetchMock = jest.fn(async () => {
      calls += 1;
      // Leaves less than one attempt needs, so a retry could only abort.
      clock += 7_700;
      if (calls === 1) return new Response('{}', { status: 503 });
      throw new DOMException('The operation timed out.', 'TimeoutError');
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    try {
      await expect(
        encryptByokForStorage({ apiKey: 'sk-test', context, actorUserId })
      ).rejects.toThrow('status 503');
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      nowSpy.mockRestore();
    }
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

describe('byok data key cache', () => {
  const settle = () => new Promise<void>(resolve => setImmediate(resolve));
  const decryptCalls = (calls: Call[]) => calls.filter(call => call.url.pathname === '/decrypt');

  async function storedEnvelope(apiKey = 'sk-secret') {
    const envelope = await encryptByokForStorage({ apiKey, context, actorUserId });
    if (!envelope) throw new Error('expected envelope');
    return envelope;
  }

  test('serves a repeat decrypt from the cache without waiting for the service', async () => {
    const { calls, fakeFetch } = installFakeKms();
    const envelope = await storedEnvelope();

    await expect(decryptByokEnvelope(envelope, context)).resolves.toBe('sk-secret');
    await settle();
    fakeFetch.mockImplementation(() => new Promise<Response>(() => {}));

    await expect(decryptByokEnvelope(envelope, context)).resolves.toBe('sk-secret');
    // data-key, the first decrypt, and the decrypt sent alongside the cache hit.
    expect(fakeFetch).toHaveBeenCalledTimes(3);
    expect(decryptCalls(calls)).toHaveLength(1);
  });

  test('still sends the service request on a cache hit and ignores its failure', async () => {
    const { calls, fakeFetch } = installFakeKms();
    const envelope = await storedEnvelope();
    await decryptByokEnvelope(envelope, context);
    await settle();
    const decryptsBefore = decryptCalls(calls).length;
    fakeFetch.mockImplementation(async () => new Response('{}', { status: 500 }));
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);

    try {
      await expect(decryptByokEnvelope(envelope, context)).resolves.toBe('sk-secret');
      await new Promise(resolve => setTimeout(resolve, 50));
      expect(fakeFetch.mock.calls.length).toBeGreaterThan(decryptsBefore + 1);
      expect(unhandled).not.toHaveBeenCalled();
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  test('does not rewrite the cache entry on a hit', async () => {
    installFakeKms();
    const envelope = await storedEnvelope();
    await decryptByokEnvelope(envelope, context);
    await settle();
    mockRedis.set.mockClear();

    await decryptByokEnvelope(envelope, context);
    await settle();

    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  test('caches only the data key, for the ttl', async () => {
    installFakeKms();
    const envelope = await storedEnvelope();
    await decryptByokEnvelope(envelope, context);
    await settle();

    expect(mockRedis.set).toHaveBeenCalledTimes(1);
    const [key, value, options] = mockRedis.set.mock.calls[0];
    expect(options).toEqual({ ex: BYOK_DATA_KEY_CACHE_TTL_SECONDS });
    expect(BYOK_DATA_KEY_CACHE_TTL_SECONDS).toBe(300);
    expect(Buffer.from(value, 'base64')).toHaveLength(32);
    expect(decryptApiKey(envelope.encrypted_data, value)).toBe('sk-secret');
    for (const stored of [key, value]) {
      expect(stored).not.toContain('sk-secret');
      expect(stored).not.toContain(envelope.encrypted_data.data);
      expect(stored).not.toContain(envelope.wrapped_dek);
      expect(stored).not.toContain(context.owner_id);
    }
  });

  test('does not serve a cached key to a different context', async () => {
    const { calls } = installFakeKms();
    const envelope = await storedEnvelope();
    await decryptByokEnvelope(envelope, context);
    await settle();

    await expect(decryptByokEnvelope(envelope, { ...context, owner_id: 'user-2' })).rejects.toThrow(
      'status 400'
    );
    expect(decryptCalls(calls)).toHaveLength(2);
  });

  test('does not serve a cached key to a replaced envelope', async () => {
    const { calls } = installFakeKms();
    const first = await storedEnvelope('sk-first');
    await decryptByokEnvelope(first, context);
    await settle();
    const second = await storedEnvelope('sk-second');

    await expect(decryptByokEnvelope(second, context)).resolves.toBe('sk-second');
    expect(decryptCalls(calls)).toHaveLength(2);
  });

  test('does not cache a data key that does not open the ciphertext', async () => {
    const envelope = await (async () => {
      installFakeKms();
      return storedEnvelope();
    })();
    global.fetch = jest.fn(async () =>
      Response.json({ data_key: randomBytes(32).toString('base64') })
    ) as unknown as typeof fetch;

    await expect(decryptByokEnvelope(envelope, context)).rejects.toThrow();
    await settle();

    expect(mockRedis.set).not.toHaveBeenCalled();
  });

  test('evicts a damaged entry and falls back to the service', async () => {
    const { calls } = installFakeKms();
    const envelope = await storedEnvelope();
    await decryptByokEnvelope(envelope, context);
    await settle();
    const [key] = mockRedis.set.mock.calls[0];
    mockRedis.store.set(key, randomBytes(32).toString('base64'));

    await expect(decryptByokEnvelope(envelope, context)).resolves.toBe('sk-secret');
    await settle();

    expect(mockRedis.del).toHaveBeenCalledWith(key);
    // The first decrypt, then the damaged hit, which used the response already in flight.
    expect(decryptCalls(calls)).toHaveLength(2);
    // The refreshed entry is the real data key again.
    await expect(decryptByokEnvelope(envelope, context)).resolves.toBe('sk-secret');
    expect(decryptCalls(calls)).toHaveLength(3);
  });

  test('falls back to the service when Redis fails', async () => {
    const { calls } = installFakeKms();
    const envelope = await storedEnvelope();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    mockRedis.get.mockRejectedValueOnce(new Error('redis://secret@host unreachable'));
    mockRedis.set.mockRejectedValueOnce(new Error('redis://secret@host unreachable'));

    try {
      await expect(decryptByokEnvelope(envelope, context)).resolves.toBe('sk-secret');
      await settle();

      expect(decryptCalls(calls)).toHaveLength(1);
      expect(JSON.stringify(warn.mock.calls)).not.toContain('secret@host');
    } finally {
      warn.mockRestore();
    }
  });

  test('does not touch Redis when the service is not configured', async () => {
    installFakeKms();
    const envelope = await storedEnvelope();
    delete process.env.BYOK_KMS_SERVICE_URL;

    await expect(decryptByokEnvelope(envelope, context)).rejects.toThrow('BYOK_KMS_SERVICE_URL');
    expect(mockRedis.get).not.toHaveBeenCalled();
  });
});
