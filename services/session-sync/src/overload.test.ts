import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it, vi } from 'vitest';

import { app } from './app';
import { getSessionSyncDOStub } from './dos/SessionSyncDO';
import type { Env } from './env';
import { batch, client, grant, newSessionID, personal, testEnv } from '../test/helpers';

const overloads = [
  () => Object.assign(new Error('Synthetic overload'), { overloaded: true, retryable: true }),
  () => new Error('Durable Object is overloaded. Requests queued for too long.'),
  () =>
    new Error(
      'Your account is generating too much load on Durable Objects. Please back off and try again later.'
    ),
];

describe('overload backpressure at the Worker RPC boundary', () => {
  for (const [index, makeError] of overloads.entries()) {
    for (const [method, suffix] of [
      ['GET', ''],
      ['PUT', ''],
      ['POST', '/batches'],
    ] as const) {
      it(`returns a retry deadline for ${method} and overload class ${index}`, async () => {
        const principal = personal(crypto.randomUUID());
        const failure = vi.fn(async () => {
          throw makeError();
        });
        const namespace = testEnv.SESSION_SYNC_DO;
        const local = {
          ...testEnv,
          SESSION_SYNC_DO: {
            idFromName: namespace.idFromName.bind(namespace),
            get: () => ({ getState: failure, register: failure, applyBatch: failure }),
          } as unknown as Env['SESSION_SYNC_DO'],
        };
        const before = Date.now();
        const response = await app.fetch(
          new Request(`https://session-sync.test/v1/sessions/${newSessionID()}${suffix}`, {
            method,
            headers: {
              authorization: `Bearer ${await grant(principal)}`,
              'content-type': 'application/json',
            },
            body:
              method === 'GET'
                ? undefined
                : JSON.stringify({ version: 1, sourceID: crypto.randomUUID() }),
          }),
          local
        );
        expect(response.status).toBe(503);
        expect(response.headers.get('Retry-After')).toBe('3');
        const body = await response.json<{ error: { code: string; retryAt: number } }>();
        expect(body.error.code).toBe('service_overloaded');
        expect(body.error.retryAt).toBeGreaterThanOrEqual(before + 3000);
        expect(failure).toHaveBeenCalledTimes(1);
      });
    }
  }

  it('classifies a stub lookup overload without retrying the lookup', async () => {
    const principal = personal(crypto.randomUUID());
    const get = vi.fn(() => {
      throw overloads[0]();
    });
    const namespace = testEnv.SESSION_SYNC_DO;
    const response = await app.fetch(
      new Request(`https://session-sync.test/v1/sessions/${newSessionID()}`, {
        headers: { authorization: `Bearer ${await grant(principal)}` },
      }),
      {
        ...testEnv,
        SESSION_SYNC_DO: { idFromName: namespace.idFromName.bind(namespace), get },
      } as unknown as Env
    );
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(await response.json()).toMatchObject({
      error: { code: 'service_overloaded', retryAt: expect.any(Number) },
    });
    expect(get).toHaveBeenCalledTimes(1);
  });

  it('preserves fail-closed tenant admission with an overload deadline', async () => {
    const principal = personal(crypto.randomUUID());
    const sessionID = newSessionID();
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    await runInDurableObject(stub, instance => {
      const exposed = instance as unknown as { env: Env };
      const namespace = exposed.env.SESSION_SYNC_TENANT_DO;
      const unavailable = async () => {
        throw Object.assign(new Error('Synthetic tenant overload'), { overloaded: true });
      };
      exposed.env = {
        ...exposed.env,
        SESSION_SYNC_TENANT_DO: {
          idFromName: namespace.idFromName.bind(namespace),
          get: () => ({
            trackCreatedSession: unavailable,
            forgetCreatedSession: unavailable,
            reserve: unavailable,
            release: unavailable,
          }),
        } as unknown as Env['SESSION_SYNC_TENANT_DO'],
      };
    });
    const api = client(principal);
    const response = await api.register(sessionID, crypto.randomUUID());
    expect(response.status).toBe(503);
    expect(response.headers.get('Retry-After')).toBe('3');
    expect(await response.json()).toMatchObject({
      error: { code: 'service_overloaded', retryAt: expect.any(Number) },
    });
    expect((await api.state(sessionID)).status).toBe(404);
  });

  it('uses the short overload deadline for a full write queue', async () => {
    const principal = personal(crypto.randomUUID());
    const api = client(principal);
    const sessionID = newSessionID();
    const source = crypto.randomUUID();
    expect((await api.register(sessionID, source)).status).toBe(201);
    const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
    await runInDurableObject(stub, instance => {
      const queue = instance as unknown as { pendingBatches: number };
      queue.pendingBatches = 8;
    });
    try {
      const response = await api.apply(sessionID, batch(source, 0, 1, []));
      expect(response.status).toBe(503);
      expect(response.headers.get('Retry-After')).toBe('3');
      expect(await response.json()).toMatchObject({
        error: { code: 'service_overloaded', retryAt: expect.any(Number) },
      });
    } finally {
      await runInDurableObject(stub, instance => {
        const queue = instance as unknown as { pendingBatches: number };
        queue.pendingBatches = 0;
      });
    }
    expect((await api.apply(sessionID, batch(source, 0, 1, []))).status).toBe(200);
  });
});
