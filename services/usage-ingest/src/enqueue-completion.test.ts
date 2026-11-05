import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleFetch, type Env } from './publish-usage';
import { usage } from './usage.test-fixture';

afterEach(() => vi.restoreAllMocks());

type Deferred = {
  promise: Promise<undefined>;
  resolve: () => void;
  reject: (reason: unknown) => void;
};

function deferred(): Deferred {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<undefined>((res, rej) => {
    resolve = () => res(undefined);
    reject = rej;
  });
  return { promise, resolve, reject };
}

function executionContext() {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    ctx: {
      waitUntil: vi.fn((promise: Promise<unknown>) => {
        pending.push(Promise.resolve(promise));
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext,
  };
}

function captureLogs() {
  const info = vi.spyOn(console, 'info').mockImplementation(() => {});
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  return {
    info,
    warn,
    records: () =>
      [...info.mock.calls, ...warn.mock.calls].map(([line]) => JSON.parse(String(line))),
  };
}

function postRequest() {
  return new Request('https://test.invalid/usage', {
    method: 'POST',
    headers: { authorization: 'Bearer secret' },
    body: JSON.stringify(usage),
  });
}

function envWith(send: ReturnType<typeof vi.fn>): Env {
  return { USAGE_INGEST_PUBLISH_SECRET: 'secret', USAGE_INGEST_QUEUE: { send } } as unknown as Env;
}

const completionEvents = ['usage_ingest_enqueue_observed'];

async function flushMicrotasks(): Promise<void> {
  for (let index = 0; index < 20; index += 1) await Promise.resolve();
}

async function state(promise: Promise<unknown>): Promise<'pending' | 'fulfilled' | 'rejected'> {
  let settled: 'fulfilled' | 'rejected' | undefined;
  void promise.then(
    () => (settled = 'fulfilled'),
    () => (settled = 'rejected')
  );
  for (let turn = 0; turn < 200 && settled === undefined; turn += 1) await Promise.resolve();
  return settled ?? 'pending';
}

describe('enqueue completion observed while the send is still pending', () => {
  it('observes the same single pending send after the response path stops waiting', async () => {
    vi.spyOn(performance, 'now').mockReturnValueOnce(0).mockReturnValueOnce(12_500);
    const logs = captureLogs();
    const send = deferred();
    const { ctx, pending } = executionContext();
    const env = envWith(vi.fn().mockReturnValue(send.promise));

    const handler = handleFetch(postRequest(), env, ctx);
    await flushMicrotasks();
    expect(pending).toHaveLength(1);

    expect(await state(handler)).toBe('pending');
    send.resolve();
    await expect(pending[0]).resolves.toBeUndefined();
    await expect(handler).resolves.toHaveProperty('status', 202);

    expect(env.USAGE_INGEST_QUEUE.send).toHaveBeenCalledTimes(1);
    const observed = logs
      .records()
      .filter(record => completionEvents.includes(record.event as string));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toEqual({
      level: 'info',
      event: 'usage_ingest_enqueue_observed',
      usage_id: usage.core.id,
      outcome: 'accepted',
      send_duration_ms: 12_500,
    });
  });

  it('records a failed pending send as unavailable without suppressing the original failure', async () => {
    const logs = captureLogs();
    const send = deferred();
    const { ctx, pending } = executionContext();
    const env = envWith(vi.fn().mockReturnValue(send.promise));

    const handler = handleFetch(postRequest(), env, ctx);
    await flushMicrotasks();
    expect(pending).toHaveLength(1);

    expect(await state(handler)).toBe('pending');
    send.reject(new Error('secret queue failure'));
    await expect(pending[0]).resolves.toBeUndefined();
    await expect(handler).resolves.toHaveProperty('status', 503);

    expect(env.USAGE_INGEST_QUEUE.send).toHaveBeenCalledTimes(1);
    const observed = logs
      .records()
      .filter(record => completionEvents.includes(record.event as string));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({
      level: 'warn',
      event: 'usage_ingest_enqueue_observed',
      usage_id: usage.core.id,
      outcome: 'unavailable',
    });
    expect(JSON.stringify(observed)).not.toContain('secret queue failure');
  });

  it('registers the observation before awaiting the send', async () => {
    captureLogs();
    const send = deferred();
    const registered: string[] = [];
    const ctx = {
      waitUntil: vi.fn(() => {
        registered.push('waitUntil');
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;

    const handler = handleFetch(postRequest(), envWith(vi.fn().mockReturnValue(send.promise)), ctx);
    await new Promise(resolve => setImmediate(resolve));
    expect(registered).toEqual(['waitUntil']);

    send.resolve();
    await handler;
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
  });

  it('keeps one send and one observation for a normal accepted send', async () => {
    const logs = captureLogs();
    const send = vi.fn().mockResolvedValue(undefined);
    const { ctx, pending } = executionContext();

    const response = await handleFetch(postRequest(), envWith(send), ctx);
    expect(response.status).toBe(202);
    await Promise.all(pending);

    expect(send).toHaveBeenCalledTimes(1);
    const observed = logs
      .records()
      .filter(record => completionEvents.includes(record.event as string));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ outcome: 'accepted' });
  });

  it('keeps one send, the 503 response and one observation for a normal failed send', async () => {
    const logs = captureLogs();
    const send = vi.fn().mockRejectedValue(new Error('queue'));
    const { ctx, pending } = executionContext();

    const response = await handleFetch(postRequest(), envWith(send), ctx);
    expect(response.status).toBe(503);
    await Promise.all(pending);

    expect(send).toHaveBeenCalledTimes(1);
    const observed = logs
      .records()
      .filter(record => completionEvents.includes(record.event as string));
    expect(observed).toHaveLength(1);
    expect(observed[0]).toMatchObject({ outcome: 'unavailable' });
  });

  it('does not change the accepted response when the observation log sink throws', async () => {
    const observationAttempts = vi.fn();
    vi.spyOn(console, 'info').mockImplementation(line => {
      if (String(line).includes('usage_ingest_enqueue_observed')) {
        observationAttempts();
        throw new Error('sink');
      }
    });
    const send = vi.fn().mockResolvedValue(undefined);
    const { ctx, pending } = executionContext();

    const response = await handleFetch(postRequest(), envWith(send), ctx);
    expect(response.status).toBe(202);
    await expect(Promise.all(pending)).resolves.toEqual([undefined]);
    expect(send).toHaveBeenCalledTimes(1);
    expect(observationAttempts).toHaveBeenCalledTimes(1);
  });

  it('keeps the original 503 and logs when waitUntil registration throws', async () => {
    const logs = captureLogs();
    const ctx = {
      waitUntil: vi.fn(() => {
        throw new Error('secret registration failure');
      }),
      passThroughOnException: vi.fn(),
    } as unknown as ExecutionContext;
    const send = vi.fn().mockRejectedValue(new Error('queue'));
    const env = envWith(send);

    const response = await handleFetch(postRequest(), env, ctx);
    expect(response.status).toBe(503);
    expect(send).toHaveBeenCalledTimes(1);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    const unregistered = logs
      .records()
      .filter(record => record.event === 'usage_ingest_enqueue_observation_unregistered');
    expect(unregistered).toEqual([
      {
        level: 'warn',
        event: 'usage_ingest_enqueue_observation_unregistered',
        usage_id: usage.core.id,
      },
    ]);
    expect(JSON.stringify(logs.records())).not.toContain('secret registration failure');
  });

  it('does not read the body, register observation or send for an unauthorized request', async () => {
    const send = vi.fn().mockResolvedValue(undefined);
    const { ctx } = executionContext();
    const env = envWith(send);
    const bodyRead = vi.fn();
    const request = new Request('https://test.invalid/usage', { method: 'POST', body: '{}' });
    Object.defineProperty(request, 'body', {
      get() {
        bodyRead();
        return null;
      },
    });

    const response = await handleFetch(request, env, ctx);

    expect(response.status).toBe(401);
    expect(bodyRead).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
    expect(ctx.waitUntil).not.toHaveBeenCalled();
  });
});
