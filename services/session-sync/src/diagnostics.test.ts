import { runInDurableObject } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/durable-sqlite';
import { afterEach, expect, it, vi } from 'vitest';

import { diagnostic, phase, syncPhase } from './metrics';
import { failureCause, rpcError, ServiceOverloaded } from './overload';
import { app } from './app';
import type { Env } from './env';
import { batch, client, grant, newSessionID, personal, testEnv } from '../test/helpers';
import { getSessionSyncDOStub } from './dos/SessionSyncDO';
import { getRelayStub } from './dos/SessionRelayDO';
import { relayWatches } from './db/relay-sqlite-schema';

function failingMetricsEnv(base: Env = testEnv) {
  const env = { ...base };
  Object.defineProperty(env, 'SESSION_SYNC_METRICS', {
    get() {
      throw new Error('Synthetic metrics binding outage');
    },
  });
  return env;
}

afterEach(() => vi.restoreAllMocks());

it.each([
  ['Too many requests queued.', 'queued_requests'],
  ['Too much data queued.', 'queued_bytes'],
  ['Requests queued for too long.', 'queue_timeout'],
  ['Too many requests for the same object within a 10 second window.', 'object_rate'],
])('classifies documented platform cause %s', (message, cause) => {
  expect(failureCause(new Error(`Durable Object is overloaded. ${message}`))).toBe(cause);
});

it('classifies flags and unknown errors without retaining error text', () => {
  expect(failureCause(Object.assign(new Error('private fixture'), { overloaded: true }))).toBe(
    'platform_unknown'
  );
  expect(failureCause(new Error('private fixture'))).toBe('unknown');
  expect(failureCause(new Error('Presence watch budget exceeded'))).toBe('watch_budget');
  expect(
    failureCause(
      new Error(
        'Your account is generating too much load on Durable Objects. Please back off and try again later.'
      )
    )
  ).toBe('account_rate');
});

it('aggregates failures by bounded labels and preserves observed platform flag counts', () => {
  const writeDataPoint = vi.fn();
  const env = { SESSION_SYNC_METRICS: { writeDataPoint } };
  const clock = vi.spyOn(Date, 'now').mockReturnValue(1000);
  const point = {
    operation: 'applyBatch' as const,
    stage: 'rpc' as const,
    tenant: 'organization' as const,
    durationMs: 3,
    error: Object.assign(new Error('Durable Object is overloaded. Too many requests queued.'), {
      overloaded: true,
      retryable: true,
    }),
  };
  diagnostic(env, point);
  for (let index = 0; index < 1000; index++) diagnostic(env, point);
  expect(writeDataPoint).toHaveBeenCalledTimes(1);
  clock.mockReturnValue(2000);
  diagnostic(env, point);
  expect(writeDataPoint.mock.calls.at(-1)?.[0]).toEqual({
    indexes: ['diagnostic_v1'],
    blobs: ['diagnostic_v1', 'applyBatch', 'rpc', 'error', 'queued_requests', 'organization'],
    doubles: [3003, 1001, 0, 0, 1001, 1001, 1],
  });
  expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain('Durable Object');
});

it('samples successful phases and preserves exceptions when the sink fails', async () => {
  const writeDataPoint = vi.fn(() => {
    throw new Error('Synthetic metric outage');
  });
  const env = { SESSION_SYNC_METRICS: { writeDataPoint } };
  vi.spyOn(Math, 'random').mockReturnValue(0);
  expect(await phase(env, 'applyBatch', 'hash', async () => 7)).toBe(7);
  expect(syncPhase(env, 'applyBatch', 'validate', () => 8)).toBe(8);
  const error = new Error('Synthetic original failure');
  await expect(
    phase(env, 'relayWatch', 'watch_rpc', async () => {
      throw error;
    })
  ).rejects.toBe(error);
  expect(() =>
    syncPhase(env, 'relayWatch', 'watch_storage', () => {
      throw error;
    })
  ).toThrow(error);
});

it('records raw RPC overload provenance before conversion and retains generic client errors', async () => {
  const writeDataPoint = vi.fn();
  const principal = personal(crypto.randomUUID());
  const namespace = testEnv.SESSION_SYNC_DO;
  const error = Object.assign(new Error('Durable Object is overloaded. Too much data queued.'), {
    overloaded: true,
    retryable: true,
  });
  const failure = vi.fn(async () => {
    throw error;
  });
  const env = {
    ...testEnv,
    SESSION_SYNC_METRICS: { writeDataPoint },
    SESSION_SYNC_DO: {
      idFromName: namespace.idFromName.bind(namespace),
      get: () => ({ getState: failure }),
    } as unknown as Env['SESSION_SYNC_DO'],
  };
  const response = await app.fetch(
    new Request(`https://session-sync.test/v1/sessions/${newSessionID()}`, {
      headers: { authorization: `Bearer ${await grant(principal)}` },
    }),
    env
  );
  expect(await response.json()).toMatchObject({
    error: {
      code: 'service_overloaded',
      message: 'Session synchronization is temporarily overloaded',
    },
  });
  expect(failure).toHaveBeenCalledTimes(1);
  expect(
    writeDataPoint.mock.calls.some(
      ([point]) =>
        point.blobs[4] === 'queued_bytes' && point.doubles[4] === 1 && point.doubles[5] === 1
    )
  ).toBe(true);
  expect(rpcError(error)).toBeInstanceOf(ServiceOverloaded);
});

it('emits a newly observed cause after the bounded failure map fills', () => {
  const writeDataPoint = vi.fn();
  const env = { SESSION_SYNC_METRICS: { writeDataPoint } };
  const stages = [
    'rpc',
    'queue_admission',
    'queue_wait',
    'rate_credit',
    'hash',
    'validate',
    'sql_transaction',
    'lease_reserve',
    'schedule',
    'watch_queue',
  ] as const;
  const causes = [
    'none',
    'application_queue',
    'queued_requests',
    'queued_bytes',
    'queue_timeout',
    'object_rate',
    'account_rate',
    'platform_unknown',
    'watch_budget',
    'typed_result',
    'unknown',
  ] as const;
  for (const tenant of ['user', 'organization'] as const)
    for (const stage of stages)
      for (const cause of causes)
        diagnostic(env, { operation: 'applyBatch', stage, cause, tenant, outcome: 'error' });
  const before = writeDataPoint.mock.calls.length;
  diagnostic(env, {
    operation: 'applyBatch',
    stage: 'rpc_lookup',
    cause: 'object_rate',
    outcome: 'error',
  });
  expect(writeDataPoint).toHaveBeenCalledTimes(before + 1);
  expect(writeDataPoint.mock.calls.at(-1)?.[0].blobs).toEqual([
    'diagnostic_v1',
    'applyBatch',
    'rpc_lookup',
    'error',
    'object_rate',
    'unknown',
  ]);
});

it('measures admission queue depth for control calls without batch bodies', async () => {
  const principal = personal(crypto.randomUUID());
  const sessionID = newSessionID();
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(stub, async instance => {
    const exposed = instance as unknown as {
      env: Env;
      quotaGate: Promise<void>;
      admissionQueueDepth: number;
    };
    const original = exposed.env;
    const writeDataPoint = vi.fn();
    exposed.env = { ...original, SESSION_SYNC_METRICS: { writeDataPoint } };
    const hold = Promise.withResolvers<void>();
    exposed.quotaGate = hold.promise;
    vi.spyOn(Math, 'random').mockReturnValue(0);
    try {
      const first = instance.authorizeLive({ principal, sessionID });
      const second = instance.authorizeLive({ principal, sessionID });
      expect(exposed.admissionQueueDepth).toBe(2);
      hold.resolve();
      await Promise.all([first, second]);
      expect(
        writeDataPoint.mock.calls
          .filter(([point]) => point.blobs[2] === 'queue_wait')
          .map(([point]) => point.doubles[2])
      ).toEqual([2, 1]);
      expect(exposed.admissionQueueDepth).toBe(0);
    } finally {
      hold.resolve();
      exposed.env = original;
      vi.restoreAllMocks();
    }
  });
});

it('runs phase callbacks once when metrics binding access fails', async () => {
  const env = failingMetricsEnv();
  const asyncWork = vi.fn(async () => 7);
  const syncWork = vi.fn(() => 8);
  expect(() => diagnostic(env, { operation: 'applyBatch', stage: 'rpc' })).not.toThrow();
  expect(await phase(env, 'applyBatch', 'rpc', asyncWork)).toBe(7);
  expect(asyncWork).toHaveBeenCalledTimes(1);
  expect(syncPhase(env, 'applyBatch', 'sql_transaction', syncWork)).toBe(8);
  expect(syncWork).toHaveBeenCalledTimes(1);
});

it('preserves original callback errors when metrics binding access fails', async () => {
  const env = failingMetricsEnv();
  const error = new Error('Synthetic original work failure');
  await expect(
    phase(env, 'applyBatch', 'rpc', async () => {
      throw error;
    })
  ).rejects.toBe(error);
  expect(() =>
    syncPhase(env, 'applyBatch', 'sql_transaction', () => {
      throw error;
    })
  ).toThrow(error);
});

it('releases batch and admission gates when metrics binding access fails', async () => {
  const principal = personal(crypto.randomUUID());
  const sessionID = newSessionID();
  const sourceID = crypto.randomUUID();
  await (await client(principal).register(sessionID, sourceID)).json();
  const stub = getSessionSyncDOStub(testEnv, { tenant: principal.tenant, sessionID });
  await runInDurableObject(stub, async instance => {
    const exposed = instance as unknown as {
      env: Env;
      pendingBatches: number;
      pendingBatchBytes: number;
      admissionQueueDepth: number;
    };
    const original = exposed.env;
    exposed.env = failingMetricsEnv(original);
    try {
      const first = await instance.applyBatch({
        principal,
        sessionID,
        body: JSON.stringify(
          batch(sourceID, 0, 1, [{ op: 'put', kind: 'message', id: 'm', value: 'first' }])
        ),
      });
      const second = await instance.applyBatch({
        principal,
        sessionID,
        body: JSON.stringify(
          batch(sourceID, 1, 2, [{ op: 'put', kind: 'message', id: 'm', value: 'second' }])
        ),
      });
      expect(first).toMatchObject({ ok: true, value: { through: 1 } });
      expect(second).toMatchObject({ ok: true, value: { through: 2 } });
      expect([
        exposed.pendingBatches,
        exposed.pendingBatchBytes,
        exposed.admissionQueueDepth,
      ]).toEqual([0, 0, 0]);
      expect(await instance.authorizeLive({ principal, sessionID })).toMatchObject({ ok: true });
    } finally {
      exposed.env = original;
    }
  });
});

it('persists watch reconciliation when metrics binding access fails', async () => {
  const principal = personal(crypto.randomUUID());
  const sessionID = newSessionID();
  const stub = getRelayStub(testEnv, principal.tenant, sessionID);
  await runInDurableObject(stub, async (instance, state) => {
    const exposed = instance as unknown as {
      env: Env;
      watchQueueDepth: number;
      notifyWatch(input: {
        userID: string;
        tenant: typeof principal.tenant;
        sessionID: string;
      }): Promise<void>;
    };
    const original = exposed.env;
    exposed.env = failingMetricsEnv(original);
    try {
      await expect(exposed.notifyWatch({ ...principal, sessionID })).resolves.toBeUndefined();
      expect(exposed.watchQueueDepth).toBe(0);
      expect(drizzle(state.storage).select().from(relayWatches).all()).toEqual([]);
    } finally {
      exposed.env = original;
    }
  });
});
