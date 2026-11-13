import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Env } from '../types.js';
import {
  consumeMaintenanceQueue,
  dispatchDueMaintenance,
  scheduleMaintenance,
} from './scheduling.js';

const watchId = '11111111-1111-4111-8111-111111111111';
function fixture() {
  const send = vi.fn().mockResolvedValue(undefined);
  const env = {
    PR_MAINTENANCE_QUEUE: { send },
    INTERNAL_API_SECRET: 'synthetic-test-secret',
    KILOCODE_BACKEND_BASE_URL: 'http://localhost:3000',
  } as unknown as Env;
  return { env, send };
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('durable maintenance scheduling', () => {
  it('keeps the Worker request alive beyond the bounded web dispatch maximum', async () => {
    const { env } = fixture();
    const deadline = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(new AbortController().signal);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ scheduled: [] })));
    await dispatchDueMaintenance(env);
    expect(deadline).toHaveBeenCalledWith(185_000);
  });
  it('schedules delayed work without a sandbox and clamps Queue delays', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'));
    const { env, send } = fixture();
    const future = { watchId, dueAt: '2026-11-12T12:03:00.000Z' };
    await scheduleMaintenance(env, future);
    expect(send).toHaveBeenCalledWith(future, { delaySeconds: 180 });
    await scheduleMaintenance(env, { watchId, dueAt: '2026-11-20T12:00:00.000Z' });
    expect(send).toHaveBeenLastCalledWith(expect.anything(), { delaySeconds: 86_400 });
  });

  it('calls bounded authenticated Postgres dispatch without creating response chains', async () => {
    const { env, send } = fixture();
    const fetcher = vi
      .fn()
      .mockResolvedValue(
        Response.json({ scheduled: [{ watchId, dueAt: '2026-11-12T12:03:00.000Z' }] })
      );
    vi.stubGlobal('fetch', fetcher);
    await dispatchDueMaintenance(env, watchId);
    expect(fetcher).toHaveBeenCalledWith(
      new URL('http://localhost:3000/api/internal/cloud-agent/pr-maintenance/dispatch'),
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'x-internal-api-key': 'synthetic-test-secret' }),
        body: JSON.stringify({ watchId, limit: 20 }),
      })
    );
    expect(send).not.toHaveBeenCalled();
  });

  it('does not acknowledge failed dispatch; cron remains the bounded recovery path', async () => {
    const { env } = fixture();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(null, { status: 503 })));
    const message = {
      body: { watchId, dueAt: new Date(0).toISOString() },
      attempts: 2,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeMaintenanceQueue({ messages: [message] } as unknown as MessageBatch<unknown>, env);
    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalledWith({ delaySeconds: 60 });
  });

  it('respects future dueAt deliveries instead of starting work early', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { env } = fixture();
    const fetcher = vi.fn();
    vi.stubGlobal('fetch', fetcher);
    const message = {
      body: { watchId, dueAt: new Date(30_000).toISOString() },
      attempts: 1,
      ack: vi.fn(),
      retry: vi.fn(),
    };
    await consumeMaintenanceQueue({ messages: [message] } as unknown as MessageBatch<unknown>, env);
    expect(message.retry).not.toHaveBeenCalled();
    expect(message.ack).toHaveBeenCalledOnce();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('rejects malformed schedules and bounded dispatch responses', async () => {
    const { env } = fixture();
    const message = { body: { watchId: 'bad' }, attempts: 1, ack: vi.fn(), retry: vi.fn() };
    await consumeMaintenanceQueue({ messages: [message] } as unknown as MessageBatch<unknown>, env);
    expect(message.ack).toHaveBeenCalledOnce();
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        Response.json({
          scheduled: Array.from({ length: 21 }, () => ({
            watchId,
            dueAt: new Date().toISOString(),
          })),
        })
      )
    );
    await expect(dispatchDueMaintenance(env)).rejects.toThrow(
      'maintenance_dispatch_response_invalid'
    );
  });

  it('keeps multiple watches bounded across cron and Queue cycles', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { env, send } = fixture();
    const second = '22222222-2222-4222-8222-222222222222';
    const scheduled = [watchId, second].map(id => ({
      watchId: id,
      dueAt: new Date(0).toISOString(),
    }));
    const fetcher = vi.fn().mockImplementation(async () => Response.json({ scheduled }));
    vi.stubGlobal('fetch', fetcher);
    for (const hint of scheduled) await scheduleMaintenance(env, hint);
    expect(send).toHaveBeenCalledTimes(2);
    expect(send).toHaveBeenLastCalledWith(scheduled[1], { delaySeconds: 5 });
    for (let cycle = 0; cycle < 8; cycle++) {
      vi.setSystemTime((cycle + 1) * 60_000);
      await dispatchDueMaintenance(env);
      if (cycle === 0) {
        for (const hint of scheduled) {
          const message = { body: hint, attempts: 1, ack: vi.fn(), retry: vi.fn() };
          await consumeMaintenanceQueue(
            { messages: [message] } as unknown as MessageBatch<unknown>,
            env
          );
          expect(message.ack).toHaveBeenCalledOnce();
          expect(message.retry).not.toHaveBeenCalled();
        }
      }
      expect(send).toHaveBeenCalledTimes(2);
    }
    expect(fetcher).toHaveBeenCalledTimes(10);
  });
});
