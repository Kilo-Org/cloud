import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type {
  SendSessionAttentionNotificationParams,
  SendSessionAttentionNotificationResult,
} from '@kilocode/notifications';
import { MAX_ATTEMPTS } from '../../src/attention-outbox';
import { markRetry } from '../../src/attention-outbox-store';

type OutboxRow = {
  request_id: string;
  reason: string;
  status: string;
  attempt_count: number;
  next_attempt_at: number | null;
  last_error: string | null;
  raised_at: number;
  resolved_at: number | null;
};

type MockO11Y = {
  ingestSessionMetrics: ReturnType<typeof vi.fn>;
};

type MockNotifications = {
  sendSessionAttentionNotification: ReturnType<typeof vi.fn>;
  sendSessionReadyNotification: ReturnType<typeof vi.fn>;
};

function getStub(kiloUserId: string, sessionId: string) {
  const doKey = `${kiloUserId}/${sessionId}`;
  const id = env.SESSION_INGEST_DO.idFromName(doKey);
  return env.SESSION_INGEST_DO.get(id);
}

function readOutboxRows(state: DurableObjectState): OutboxRow[] {
  return [
    ...state.storage.sql.exec<OutboxRow>('SELECT * FROM attention_outbox ORDER BY request_id'),
  ];
}

function readMeta(state: DurableObjectState, key: string): string | null {
  const cursor = state.storage.sql.exec<{ value: string | null }>(
    'SELECT value FROM ingest_meta WHERE key = ?',
    key
  );
  const row = cursor.next().value;
  return row?.value ?? null;
}

function getStoreDb(instance: DurableObject): DrizzleSqliteDODatabase {
  return (instance as unknown as { db: DrizzleSqliteDODatabase }).db;
}

function makeMockNotifications(
  calls: SendSessionAttentionNotificationParams[],
  behavior: (
    params: SendSessionAttentionNotificationParams
  ) => Promise<SendSessionAttentionNotificationResult> = async () => ({
    dispatched: true,
  })
): MockNotifications {
  return {
    sendSessionAttentionNotification: vi.fn(
      async (params: SendSessionAttentionNotificationParams) => {
        calls.push(params);
        return behavior(params);
      }
    ),
    sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })),
  };
}

function makeMockO11Y(): MockO11Y {
  return {
    ingestSessionMetrics: vi.fn(async () => {}),
  };
}

function createDeferred<T>() {
  let resolve: (value: T) => void = () => {};
  let reject: (reason: unknown) => void = () => {};
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installMocks(instance: DurableObject, mock: MockNotifications, o11y: MockO11Y) {
  const typed = instance as unknown as {
    env: { NOTIFICATIONS: MockNotifications; O11Y: MockO11Y };
  };
  typed.env.NOTIFICATIONS = mock;
  typed.env.O11Y = o11y;
}

function runAlarm(instance: DurableObject): Promise<void> {
  return (instance as unknown as { alarm: () => Promise<void> }).alarm();
}

const kiloUserId = 'usr_attention_integration';

async function seedSession(stub: ReturnType<typeof getStub>, sessionId: string): Promise<void> {
  return runInDurableObject(stub, async (instance, state) => {
    installMocks(instance, makeMockNotifications([]), makeMockO11Y());
    await instance.ingest(
      [{ type: 'session', data: { title: 'Attention Test Session' } }],
      kiloUserId,
      sessionId,
      1
    );
    await state.storage.deleteAlarm();
  });
}

describe('SessionIngestDO attention outbox integration', () => {
  const createdSessionIds: string[] = [];

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(async () => {
    vi.useRealTimers();
    for (const sessionId of createdSessionIds) {
      const stub = getStub(kiloUserId, sessionId);
      // Delete any scheduled alarm before clearing so cleanup cannot trigger an
      // alarm with real (or absent) bindings installed.
      await runInDurableObject(stub, async (_instance, state) => {
        await state.storage.deleteAlarm();
      });
      await stub.clear();
    }
    createdSessionIds.length = 0;
  });

  function trackSession(sessionId: string) {
    createdSessionIds.push(sessionId);
    return sessionId;
  }

  it('records one outbox row for duplicate raises and dispatches on alarm', async () => {
    const sessionId = trackSession('ses_attention_duplicate_resolve');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_dup_resolve',
        intent: { kind: 'raise', reason: 'question' },
      });
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_dup_resolve',
        intent: { kind: 'raise', reason: 'question' },
      });
      await runAlarm(instance);
      const rows = readOutboxRows(state);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        request_id: 'req_dup_resolve',
        status: 'dispatched',
        attempt_count: 0,
      });
    });
  });

  it('keeps distinct request ids as separate rows', async () => {
    const sessionId = trackSession('ses_attention_distinct');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_a',
        intent: { kind: 'raise', reason: 'question' },
      });
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_b',
        intent: { kind: 'raise', reason: 'permission' },
      });
      await runAlarm(instance);
      const rows = readOutboxRows(state);
      expect(rows).toHaveLength(2);
      expect(rows.map(r => r.request_id)).toEqual(['req_a', 'req_b']);
      expect(rows.every(r => r.status === 'dispatched')).toBe(true);
    });
  });

  it('resolves a pending request before dispatch and no-ops on re-raise', async () => {
    const sessionId = trackSession('ses_attention_resolve_first');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const calls: SendSessionAttentionNotificationParams[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_resolved_first',
        intent: { kind: 'raise', reason: 'question' },
      });
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_resolved_first',
        intent: { kind: 'resolve' },
      });
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_resolved_first',
        intent: { kind: 'raise', reason: 'question' },
      });
      await runAlarm(instance);
      const rows = readOutboxRows(state);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        request_id: 'req_resolved_first',
        status: 'resolved',
        resolved_at: expect.any(Number),
      });
      expect(calls).toHaveLength(0);
    });
  });

  it('returns accepted:false for invalid input or a deleted session', async () => {
    const sessionId = trackSession('ses_attention_invalid_deleted');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async instance => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      await expect(
        instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_1',
          intent: { kind: 'raise', reason: 'unknown_reason' },
        } as unknown as Record<string, unknown>)
      ).resolves.toEqual({ accepted: false, reason: 'invalid_input' });
    });

    await stub.clear();

    await runInDurableObject(stub, async instance => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      await expect(
        instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_1',
          intent: { kind: 'raise', reason: 'question' },
        })
      ).resolves.toEqual({ accepted: false, reason: 'deleted' });
    });
  });

  it('schedules an immediate alarm for a raise while preserving a later metrics deadline', async () => {
    const sessionId = trackSession('ses_attention_alarm_preempt');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      await instance.ingest(
        [{ type: 'session_close', data: { reason: 'completed' } }],
        kiloUserId,
        sessionId,
        1
      );

      const metricsAlarmBefore = Number(readMeta(state, 'metricsAlarmAt') ?? '0');
      expect(metricsAlarmBefore).toBeGreaterThan(0);
      expect(Number.isFinite(metricsAlarmBefore)).toBe(true);

      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_preempt',
        intent: { kind: 'raise', reason: 'question' },
      });

      const alarmTime = await state.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
      expect(Number.isFinite(alarmTime)).toBe(true);
      expect(alarmTime).toBeLessThan(metricsAlarmBefore);
      expect(readMeta(state, 'metricsAlarmAt')).toBe(String(metricsAlarmBefore));
      await state.storage.deleteAlarm();
    });
  });

  it('lets the earlier metrics deadline win when no outbox work is due sooner', async () => {
    const sessionId = trackSession('ses_attention_metrics_wins');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      await instance.ingest(
        [{ type: 'session_close', data: { reason: 'completed' } }],
        kiloUserId,
        sessionId,
        1
      );
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_metrics_later',
        intent: { kind: 'raise', reason: 'question' },
      });

      const metricsAlarm = Number(readMeta(state, 'metricsAlarmAt') ?? '0');
      expect(metricsAlarm).toBeGreaterThan(0);
      expect(Number.isFinite(metricsAlarm)).toBe(true);

      let alarmTime = await state.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
      expect(Number.isFinite(alarmTime)).toBe(true);
      expect(alarmTime).toBeLessThan(metricsAlarm);

      // Manually advance the outbox next_attempt_at to after the metrics alarm
      // so the metrics deadline is the next candidate.
      state.storage.sql.exec(
        'UPDATE attention_outbox SET next_attempt_at = ? WHERE request_id = ?',
        metricsAlarm + 10_000,
        'req_metrics_later'
      );
      // Trigger a reschedule without changing the outbox state by resolving a
      // request id that was never raised. The alarm should move to the earlier
      // metrics deadline because the outbox is now due later.
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_nonexistent_for_reschedule',
        intent: { kind: 'resolve' },
      });
      alarmTime = await state.storage.getAlarm();
      expect(alarmTime).toBe(metricsAlarm);
      await state.storage.deleteAlarm();
    });
  });

  it('alarm sends only userId, cliSessionId, requestId, and reason to notifications', async () => {
    const sessionId = trackSession('ses_attention_payload_shape');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const calls: SendSessionAttentionNotificationParams[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_payload_shape',
        intent: { kind: 'raise', reason: 'blocking_suggestion' },
      });
      await runAlarm(instance);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({
        userId: kiloUserId,
        cliSessionId: sessionId,
        requestId: 'req_payload_shape',
        reason: 'blocking_suggestion',
      });
    });
  });

  it('transitions dispatched, suppressed_presence, and missing_session to terminal', async () => {
    const sessionId = trackSession('ses_attention_terminal');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_dispatched',
        intent: { kind: 'raise', reason: 'question' },
      });
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_suppressed',
        intent: { kind: 'raise', reason: 'permission' },
      });
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_missing',
        intent: { kind: 'raise', reason: 'blocking_suggestion' },
      });

      const resultsByRequestId: Record<string, SendSessionAttentionNotificationResult> = {
        req_dispatched: { dispatched: true },
        req_suppressed: { dispatched: false, reason: 'suppressed_presence' },
        req_missing: { dispatched: false, reason: 'missing_session' },
      };
      const calls: SendSessionAttentionNotificationParams[] = [];
      installMocks(
        instance,
        makeMockNotifications(
          calls,
          async params => resultsByRequestId[params.requestId] ?? { dispatched: true }
        ),
        makeMockO11Y()
      );
      await runAlarm(instance);
      const rows = readOutboxRows(state);
      expect(rows).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ request_id: 'req_dispatched', status: 'dispatched' }),
          expect.objectContaining({
            request_id: 'req_suppressed',
            status: 'suppressed_presence',
          }),
          expect.objectContaining({ request_id: 'req_missing', status: 'missing_session' }),
        ])
      );
    });
  });

  it.each(['resolved', 'dispatched', 'suppressed_presence', 'missing_session', 'failed'])(
    'markRetry is a no-op for terminal status %s',
    async status => {
      const sessionId = trackSession(`ses_attention_mark_retry_${status}`);
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      await runInDurableObject(stub, async (instance, state) => {
        installMocks(instance, makeMockNotifications([]), makeMockO11Y());
        const db = getStoreDb(instance);

        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_terminal',
          intent: { kind: 'raise', reason: 'question' },
        });

        // Force the row into a terminal status so we can verify retries cannot
        // resurrect finished work.
        state.storage.sql.exec(
          'UPDATE attention_outbox SET status = ?, attempt_count = ? WHERE request_id = ?',
          status,
          3,
          'req_terminal'
        );

        const before = readOutboxRows(state)[0];
        expect(before?.status).toBe(status);
        expect(before?.attempt_count).toBe(3);

        markRetry(db, {
          requestId: 'req_terminal',
          now: Date.now(),
          reason: 'should not apply',
        });

        const after = readOutboxRows(state)[0];
        expect(after).toMatchObject({
          request_id: 'req_terminal',
          status,
          attempt_count: 3,
          last_error: before?.last_error ?? null,
        });
      });
    }
  );

  it('retries dispatch_failed with bounded backoff and parks at failed after max attempts', async () => {
    const sessionId = trackSession('ses_attention_retry_cap');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const calls: SendSessionAttentionNotificationParams[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      installMocks(
        instance,
        makeMockNotifications(calls, async () => ({
          dispatched: false,
          reason: 'dispatch_failed',
        })),
        makeMockO11Y()
      );
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_retry_cap',
        intent: { kind: 'raise', reason: 'question' },
      });
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        vi.advanceTimersByTime(10 * 60 * 60 * 1000); // far in the future
        await runAlarm(instance);
      }

      const row = readOutboxRows(state)[0];
      expect(row).toMatchObject({
        request_id: 'req_retry_cap',
        status: 'failed',
        attempt_count: MAX_ATTEMPTS,
        next_attempt_at: null,
        last_error: 'dispatch_failed',
      });
      expect(calls).toHaveLength(MAX_ATTEMPTS);
    });
  });

  it('retries a thrown RPC error with bounded backoff and parks at failed after max attempts', async () => {
    const sessionId = trackSession('ses_attention_rpc_error');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(
        instance,
        {
          sendSessionAttentionNotification: vi.fn(async () => {
            throw new Error('this sensitive upstream message must not be stored');
          }),
          sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })),
        },
        makeMockO11Y()
      );
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_rpc_error',
        intent: { kind: 'raise', reason: 'permission' },
      });
      for (let i = 0; i < MAX_ATTEMPTS; i++) {
        vi.advanceTimersByTime(10 * 60 * 60 * 1000);
        await runAlarm(instance);
      }

      const row = readOutboxRows(state)[0];
      expect(row).toMatchObject({
        request_id: 'req_rpc_error',
        status: 'failed',
        attempt_count: MAX_ATTEMPTS,
        next_attempt_at: null,
        last_error: 'rpc_error',
      });
    });
  });

  it('recovers stale in_flight rows and retries them safely', async () => {
    const sessionId = trackSession('ses_attention_stale_recovery');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const calls: SendSessionAttentionNotificationParams[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_stale',
        intent: { kind: 'raise', reason: 'question' },
      });
      // Simulate a crash: mark the row in_flight without dispatching.
      state.storage.sql.exec(
        "UPDATE attention_outbox SET status = 'in_flight' WHERE request_id = 'req_stale'"
      );
      expect(readOutboxRows(state)[0]?.status).toBe('in_flight');

      // First alarm recovers the stale row to pending with a backoff.
      await runAlarm(instance);
      const rowAfterRecovery = readOutboxRows(state)[0];
      expect(rowAfterRecovery).toMatchObject({
        request_id: 'req_stale',
        status: 'pending',
        attempt_count: 1,
      });
      expect(calls).toHaveLength(0);

      // Advance past the recovery backoff and retry.
      vi.advanceTimersByTime(10_000);
      await runAlarm(instance);

      expect(calls).toHaveLength(1);
      const row = readOutboxRows(state)[0];
      expect(row).toMatchObject({
        request_id: 'req_stale',
        status: 'dispatched',
        attempt_count: 1,
      });
    });
  });

  it('resolve during awaited RPC wins and is not overwritten', async () => {
    const sessionId = trackSession('ses_attention_resolve_race');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const deferred = createDeferred<SendSessionAttentionNotificationResult>();
    const mock: MockNotifications = {
      sendSessionAttentionNotification: vi.fn(async () => deferred.promise),
      sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })),
    };

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, mock, makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_resolve_race',
        intent: { kind: 'raise', reason: 'question' },
      });

      const alarmPromise = runAlarm(instance);
      // The alarm has claimed the row and is awaiting the RPC promise.
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_resolve_race',
        intent: { kind: 'resolve' },
      });

      expect(readOutboxRows(state)[0]?.status).toBe('resolved');

      deferred.resolve({ dispatched: true });
      await alarmPromise;

      const row = readOutboxRows(state)[0];
      expect(row).toMatchObject({
        request_id: 'req_resolve_race',
        status: 'resolved',
      });
      expect(mock.sendSessionAttentionNotification).toHaveBeenCalledTimes(1);
    });
  });

  it('resolve during a thrown RPC is not overwritten by retry', async () => {
    const sessionId = trackSession('ses_attention_resolve_race_error');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const deferred = createDeferred<SendSessionAttentionNotificationResult>();
    const mock: MockNotifications = {
      sendSessionAttentionNotification: vi.fn(async () => deferred.promise),
      sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })),
    };

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, mock, makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_resolve_race_error',
        intent: { kind: 'raise', reason: 'question' },
      });

      const alarmPromise = runAlarm(instance);
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_resolve_race_error',
        intent: { kind: 'resolve' },
      });

      deferred.reject(new Error('sensitive upstream message'));
      await alarmPromise;

      const row = readOutboxRows(state)[0];
      expect(row).toMatchObject({
        request_id: 'req_resolve_race_error',
        status: 'resolved',
        last_error: null,
      });
      expect(mock.sendSessionAttentionNotification).toHaveBeenCalledTimes(1);
    });
  });

  it('keeps the outbox retry alarm after metrics emission', async () => {
    const sessionId = trackSession('ses_attention_metrics_outbox_alarm');
    const stub = getStub(kiloUserId, sessionId);

    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      await instance.ingest(
        [
          { type: 'session', data: { title: 'Outbox Alarm After Metrics' } },
          { type: 'session_close', data: { reason: 'completed' } },
        ],
        kiloUserId,
        sessionId,
        1
      );
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_outbox_after_metrics',
        intent: { kind: 'raise', reason: 'question' },
      });

      // First alarm: dispatch the outbox and emit metrics.
      await runAlarm(instance);
      expect(readMeta(state, 'metricsEmitted')).toBe('true');
      expect(readMeta(state, 'metricsAlarmAt')).toBeNull();

      // The outbox row is dispatched, so the only remaining work is gone.
      let alarmTime = await state.storage.getAlarm();
      expect(alarmTime).toBeNull();

      // A new raise after metrics must reschedule the alarm.
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_after_metrics',
        intent: { kind: 'raise', reason: 'permission' },
      });

      alarmTime = await state.storage.getAlarm();
      expect(alarmTime).not.toBeNull();
      expect(Number.isFinite(alarmTime)).toBe(true);
      await state.storage.deleteAlarm();
    });
  });
});
