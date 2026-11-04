import { SELF, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';

import { app } from '../../src/app';
import { getSessionSyncDOStub } from '../../src/dos/SessionSyncDO';
import type { Env } from '../../src/env';
import { batch, client, grant, newSessionID, personal, testEnv } from '../helpers';

it('limits exchange by IP before credential verification with a retry deadline', async () => {
  const ip = `192.0.2.${Math.floor(Math.random() * 200) + 1}`;
  let response: Response | undefined;
  for (let index = 0; index <= 120; index++) {
    response = await SELF.fetch('https://session-sync.test/v1/auth/exchange', {
      method: 'POST',
      headers: { 'CF-Connecting-IP': ip },
    });
    if (response.status === 429) break;
    expect(response.status).toBe(401);
  }
  expect(response!.status).toBe(429);
  expect(response!.headers.get('Retry-After')).toBe('60');
  expect(await response!.json()).toMatchObject({
    error: { code: 'rate_limited', retryAt: expect.any(Number) },
  });
});

it('limits registration before dispatching to the session object', async () => {
  const response = await app.request(
    'https://session-sync.test/v1/sessions/ses_limited',
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${await grant(personal('limited-user'))}` },
    },
    { ...testEnv, USER_REQUEST_LIMITER: { limit: async () => ({ success: false }) } }
  );
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
});

it('limits blob PUTs separately from ordinary authenticated requests', async () => {
  const response = await app.request(
    `https://session-sync.test/v1/sessions/ses_limited/blobs/${'a'.repeat(64)}`,
    {
      method: 'PUT',
      headers: { authorization: `Bearer ${await grant(personal('limited-blob-user'))}` },
    },
    {
      ...testEnv,
      USER_REQUEST_LIMITER: { limit: async () => ({ success: true }) },
      USER_BLOB_LIMITER: { limit: async () => ({ success: false }) },
    }
  );
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
});

it('returns the session budget denial with the existing retry contract', async () => {
  const principal = personal(`session-limit-${crypto.randomUUID()}`);
  const id = newSessionID();
  const api = client(principal);
  expect((await api.register(id, crypto.randomUUID())).status).toBe(201);
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: id });
  await runInDurableObject(stub, instance => {
    const exposed = instance as unknown as { dataRateLimit: { tokens: number; updatedAt: number } };
    exposed.dataRateLimit.tokens = -1200;
    exposed.dataRateLimit.updatedAt = Date.now();
  });
  const response = await api.state(id);
  expect(response.status).toBe(429);
  expect(response.headers.get('Retry-After')).toBe('60');
  expect(await response.json()).toMatchObject({
    error: { code: 'rate_limited', retryAt: expect.any(Number) },
  });
});

it('calls the user block binding once per ten admitted batch requests', async () => {
  const principal = personal(`batch-limit-${crypto.randomUUID()}`);
  const id = newSessionID();
  const sourceID = crypto.randomUUID();
  const api = client(principal);
  expect((await api.register(id, sourceID)).status).toBe(201);
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID: id });
  await runInDurableObject(stub, instance => {
    const exposed = instance as unknown as { env: Env; chargedBlocks: number };
    exposed.chargedBlocks = 0;
    exposed.env = {
      ...exposed.env,
      USER_DATA_BLOCK_LIMITER: {
        limit: async () => {
          exposed.chargedBlocks++;
          return { success: true };
        },
      },
    };
  });
  for (let index = 0; index < 30; index++) {
    const response = await api.apply(
      id,
      batch(sourceID, index, index + 1, [{ op: 'put', kind: 'message', id: 'm', value: index }])
    );
    expect(response.status).toBe(200);
  }
  await runInDurableObject(stub, instance => {
    // Inspect the counter installed above on the real object instance.
    const exposed = instance as unknown as { chargedBlocks: number };
    expect(exposed.chargedBlocks).toBe(3);
  });
});

it('keeps one user within its aggregate prepaid ceiling across many session objects', async () => {
  const principal = personal(`aggregate-limit-${crypto.randomUUID()}`);
  const api = client(principal);
  const ids = Array.from({ length: 8 }, newSessionID);
  const blockLimit = 3;
  let successfulCharges = 0;
  const limiter: RateLimit = {
    limit: async ({ key }) => {
      expect(key).toBe(principal.userID);
      if (successfulCharges === blockLimit) return { success: false };
      successfulCharges++;
      return { success: true };
    },
  };
  for (const sessionID of ids) {
    expect((await api.register(sessionID, crypto.randomUUID())).status).toBe(201);
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    await runInDurableObject(stub, instance => {
      // Replace only the binding; admission still runs in each real session object.
      const exposed = instance as unknown as { env: Env };
      exposed.env = { ...exposed.env, USER_DATA_BLOCK_LIMITER: limiter };
    });
  }
  let admitted = 0;
  const check = async (response: Response) => {
    if (response.status === 200) {
      admitted++;
    } else {
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(await response.json()).toMatchObject({
        error: { code: 'rate_limited', retryAt: expect.any(Number) },
      });
    }
    expect(admitted).toBeLessThanOrEqual(10 * successfulCharges);
  };
  // A fresh session cannot admit even its first request without charging the user.
  for (const id of ids) await check(await api.state(id));
  expect(admitted).toBe(blockLimit);
  expect(successfulCharges).toBe(blockLimit);
  // Spread further requests over all sessions, consuming purchased credits only.
  // Window expiry may discard unused credits, but must never increase admission.
  for (let round = 0; round < 10; round++) {
    for (const id of ids) await check(await api.state(id));
  }
  expect(admitted).toBeLessThanOrEqual(10 * blockLimit);
  for (const id of ids) {
    const response = await api.state(id);
    expect(response.status).toBe(429);
    await check(response);
  }
});
