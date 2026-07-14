import { env, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { DrizzleSqliteDODatabase } from 'drizzle-orm/durable-sqlite';
import type {
  SendSessionAttentionNotificationParams,
  SendSessionAttentionNotificationResult,
} from '@kilocode/notifications';
import {
  MAX_ATTEMPTS,
  ATTENTION_MAX_DISPATCH_AGE_MS,
  dispatchDeadline,
} from '../../src/attention-outbox';
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
        intent: { kind: 'resolve', reason: 'question' },
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

  // Kilobot finding 4: an unknown resolve arriving before a raise must
  // persist a terminal resolved tombstone so a later raise cannot notify.
  // The original resolve reason is preserved on the tombstone; subsequent
  // resolves (even with a different reason) and the late raise are all
  // no-ops, and the dispatch loop never sees the row.
  it.each(['question', 'permission', 'blocking_suggestion'] as const)(
    'unknown resolve for reason %s persists a tombstone and a later raise is a no-op',
    async reason => {
      const sessionId = trackSession(`ses_attention_unknown_resolve_${reason}`);
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      const calls: SendSessionAttentionNotificationParams[] = [];
      await runInDurableObject(stub, async (instance, state) => {
        installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
        // 1) Unknown resolve arrives first — no matching raise yet.
        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_unknown_first',
          intent: { kind: 'resolve', reason },
        });
        const rowsAfterResolve = readOutboxRows(state);
        expect(rowsAfterResolve).toHaveLength(1);
        expect(rowsAfterResolve[0]).toMatchObject({
          request_id: 'req_unknown_first',
          reason,
          status: 'resolved',
          attempt_count: 0,
          next_attempt_at: null,
          last_error: null,
        });
        // raisedAt and resolvedAt are both the unknown-resolve timestamp
        // so the tombstone is unambiguously a "we saw a resolve but never
        // a raise" row.
        expect(rowsAfterResolve[0]?.raised_at).toBe(rowsAfterResolve[0]?.resolved_at);

        // 2) Late raise arrives — must NOT enqueue a notification.
        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_unknown_first',
          intent: { kind: 'raise', reason },
        });
        await runAlarm(instance);

        const rowsAfterLateRaise = readOutboxRows(state);
        expect(rowsAfterLateRaise).toHaveLength(1);
        expect(rowsAfterLateRaise[0]).toMatchObject({
          request_id: 'req_unknown_first',
          reason,
          status: 'resolved',
          attempt_count: 0,
          next_attempt_at: null,
        });
        // The tombstone's reason is preserved (the late raise's reason
        // does not overwrite it) and no notification was ever dispatched.
        expect(calls).toHaveLength(0);
      });
    }
  );

  it('repeat unknown resolve is stable and does not change the tombstone reason or status', async () => {
    const sessionId = trackSession('ses_attention_unknown_resolve_repeat');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const calls: SendSessionAttentionNotificationParams[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_repeat_resolve',
        intent: { kind: 'resolve', reason: 'question' },
      });
      // Repeat unknown resolve with a different reason — the original
      // reason must be preserved, and the row must not flap status.
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_repeat_resolve',
        intent: { kind: 'resolve', reason: 'permission' },
      });
      await runAlarm(instance);

      const rows = readOutboxRows(state);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        request_id: 'req_repeat_resolve',
        reason: 'question',
        status: 'resolved',
        attempt_count: 0,
        next_attempt_at: null,
        last_error: null,
      });
      expect(calls).toHaveLength(0);
    });
  });

  it('unknown resolve does not schedule a fresh outbox alarm of its own', async () => {
    const sessionId = trackSession('ses_attention_unknown_resolve_no_alarm');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, makeMockNotifications([]), makeMockO11Y());
      // No prior outbox work exists, no metrics deadline.
      expect(await state.storage.getAlarm()).toBeNull();
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_unknown_no_alarm',
        intent: { kind: 'resolve', reason: 'question' },
      });
      // The tombstone carries no scheduled attempt and no raise, so the
      // shared alarm scheduler must NOT reschedule on its own.
      expect(await state.storage.getAlarm()).toBeNull();
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
      // request id that was never raised. The tombstone carries no
      // scheduled attempt, so the alarm should move to the earlier
      // metrics deadline because the outbox is now due later.
      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_nonexistent_for_reschedule',
        intent: { kind: 'resolve', reason: 'question' },
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
    // Each iteration advances just past the next backoff. The full
    // 6-alarm sequence completes in well under the 55min absolute
    // dispatch window so the cap-by-attempt-count is the trigger
    // (not the window).
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
      // 6min per alarm × 10 iterations = 60min total. The first 5
      // dispatches happen inside the 55min window; the 6th retry's
      // 60min backoff crosses the absolute deadline, so markRetry
      // parks the row as failed without scheduling a 7th dispatch.
      for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
        vi.advanceTimersByTime(6 * 60 * 1000);
        await runAlarm(instance);
      }

      const row = readOutboxRows(state)[0];
      expect(row).toMatchObject({
        request_id: 'req_retry_cap',
        status: 'failed',
        next_attempt_at: null,
        last_error: 'dispatch_failed',
      });
      // 6 dispatches total — 7th never happens because the window
      // parks the row first.
      expect(calls).toHaveLength(6);
      expect(row?.attempt_count).toBe(6);
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
      for (let i = 0; i < MAX_ATTEMPTS + 3; i++) {
        vi.advanceTimersByTime(6 * 60 * 1000);
        await runAlarm(instance);
      }

      const row = readOutboxRows(state)[0];
      expect(row).toMatchObject({
        request_id: 'req_rpc_error',
        status: 'failed',
        next_attempt_at: null,
        last_error: 'rpc_error',
      });
      expect(row?.attempt_count).toBe(6);
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
        intent: { kind: 'resolve', reason: 'question' },
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
        intent: { kind: 'resolve', reason: 'question' },
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

  it('does not emit metrics from immediate attention alarm when the deadline is in the future', async () => {
    // Regression for Kilobot finding 3: the immediate-attention outbox alarm
    // used to call `emitSessionMetrics` unconditionally, so a raise fired
    // long before the actual metrics deadline would prematurely publish
    // session metrics. The alarm must only emit when the persisted
    // `metricsAlarmAt` is finite, positive, and <= Date.now().
    const sessionId = trackSession('ses_attention_metrics_future_deadline');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const calls: SendSessionAttentionNotificationParams[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const o11y = makeMockO11Y();
      installMocks(instance, makeMockNotifications(calls), o11y);

      // Close sets `metricsAlarmAt` to now + POST_CLOSE_DRAIN_MS (5s).
      await instance.ingest(
        [{ type: 'session_close', data: { reason: 'completed' } }],
        kiloUserId,
        sessionId,
        1
      );

      const metricsAlarmBefore = Number(readMeta(state, 'metricsAlarmAt') ?? '0');
      expect(metricsAlarmBefore).toBeGreaterThan(Date.now());
      expect(Number.isFinite(metricsAlarmBefore)).toBe(true);

      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_future_deadline',
        intent: { kind: 'raise', reason: 'question' },
      });

      await runAlarm(instance);

      // Notification dispatched, metrics NOT emitted.
      expect(calls).toHaveLength(1);
      expect(calls[0]).toMatchObject({ requestId: 'req_future_deadline' });
      expect(o11y.ingestSessionMetrics).not.toHaveBeenCalled();
      expect(readMeta(state, 'metricsEmitted')).not.toBe('true');
      // The persisted deadline must be untouched by the immediate alarm.
      expect(readMeta(state, 'metricsAlarmAt')).toBe(String(metricsAlarmBefore));
      // The shared alarm is rescheduled to the metrics deadline (no more
      // outbox work, future deadline still pending).
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).toBe(metricsAlarmBefore);
      await state.storage.deleteAlarm();
    });
  });

  it('emits metrics from the attention alarm once the deadline arrives', async () => {
    const sessionId = trackSession('ses_attention_metrics_at_deadline');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const calls: SendSessionAttentionNotificationParams[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const o11y = makeMockO11Y();
      installMocks(instance, makeMockNotifications(calls), o11y);

      await instance.ingest(
        [{ type: 'session_close', data: { reason: 'completed' } }],
        kiloUserId,
        sessionId,
        1
      );

      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_at_deadline',
        intent: { kind: 'raise', reason: 'question' },
      });

      // First alarm at the immediate tick: outbox dispatched, metrics not yet.
      await runAlarm(instance);
      expect(calls).toHaveLength(1);
      expect(o11y.ingestSessionMetrics).not.toHaveBeenCalled();

      // Advance past the metrics deadline (POST_CLOSE_DRAIN_MS = 5s).
      vi.advanceTimersByTime(6_000);
      await runAlarm(instance);

      expect(o11y.ingestSessionMetrics).toHaveBeenCalledTimes(1);
      expect(readMeta(state, 'metricsEmitted')).toBe('true');
      expect(readMeta(state, 'metricsAlarmAt')).toBeNull();
      await state.storage.deleteAlarm();
    });
  });

  it('skips metrics when the alarm fires without a persisted deadline (legacy compatibility)', async () => {
    // Legacy platform alarms may reach `alarm()` without `metricsAlarmAt`
    // ever being written. The fix must not crash, must not emit, and must
    // still reschedule the next outbox tick.
    const sessionId = trackSession('ses_attention_metrics_legacy_no_deadline');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const calls: SendSessionAttentionNotificationParams[] = [];
    await runInDurableObject(stub, async (instance, state) => {
      const o11y = makeMockO11Y();
      installMocks(instance, makeMockNotifications(calls), o11y);

      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_legacy_no_deadline',
        intent: { kind: 'raise', reason: 'question' },
      });

      // Defensive: ensure no deadline is persisted (none is set by the
      // raise path on its own).
      expect(readMeta(state, 'metricsAlarmAt')).toBeNull();

      await runAlarm(instance);

      expect(calls).toHaveLength(1);
      expect(o11y.ingestSessionMetrics).not.toHaveBeenCalled();
      expect(readMeta(state, 'metricsEmitted')).not.toBe('true');
      // No more outbox work, so the next alarm is cleared.
      const nextAlarm = await state.storage.getAlarm();
      expect(nextAlarm).toBeNull();
    });
  });

  it('re-reads the metrics deadline after dispatchOutboxBatch (reread on IO await)', async () => {
    // Race regression: a prior code path read metricsEmitted/metricsAlarmAt
    // once at the top of `alarm()` and then emitted metrics even if the
    // deadline had been deleted or pushed during the awaited
    // `sendSessionAttentionNotification` call. The fix re-reads after the
    // dispatch loop returns so a concurrent update wins.
    const sessionId = trackSession('ses_attention_metrics_reread');
    const stub = getStub(kiloUserId, sessionId);
    await seedSession(stub, sessionId);

    const deferred = createDeferred<SendSessionAttentionNotificationResult>();
    const mock: MockNotifications = {
      sendSessionAttentionNotification: vi.fn(async () => deferred.promise),
      sendSessionReadyNotification: vi.fn(async () => ({ dispatched: true })),
    };
    const o11y = makeMockO11Y();

    await runInDurableObject(stub, async (instance, state) => {
      installMocks(instance, mock, o11y);

      // Pre-set a far-future deadline so the OLD code would still try to
      // emit (because it had read `metricsEmitted` once at the top of
      // alarm() and then ignored the deadline entirely). With the fix, the
      // alarm re-reads after the await and sees the future deadline.
      await instance.ingest(
        [{ type: 'session_close', data: { reason: 'completed' } }],
        kiloUserId,
        sessionId,
        1
      );
      const initialDeadline = Number(readMeta(state, 'metricsAlarmAt') ?? '0');
      expect(initialDeadline).toBeGreaterThan(Date.now());

      await instance.recordAttentionEvent({
        kiloUserId,
        sessionId,
        requestId: 'req_reread',
        intent: { kind: 'raise', reason: 'question' },
      });

      const alarmPromise = runAlarm(instance);

      // While the notification RPC is awaited, simulate a concurrent update
      // that pushes the deadline further out (e.g. a new session_open
      // resetting the inactivity timer).
      const newDeadline = Date.now() + 10 * 60 * 1000;
      state.storage.sql.exec(
        "UPDATE ingest_meta SET value = ? WHERE key = 'metricsAlarmAt'",
        String(newDeadline)
      );

      deferred.resolve({ dispatched: true });
      await alarmPromise;

      expect(mock.sendSessionAttentionNotification).toHaveBeenCalledTimes(1);
      // The fix re-reads the deadline after the await; the push must not
      // emit metrics, and the deadline must be the concurrent value.
      expect(o11y.ingestSessionMetrics).not.toHaveBeenCalled();
      expect(readMeta(state, 'metricsEmitted')).not.toBe('true');
      expect(Number(readMeta(state, 'metricsAlarmAt'))).toBe(newDeadline);
      await state.storage.deleteAlarm();
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

      // First alarm: dispatches the outbox. With the fix, it does NOT emit
      // metrics because the deadline (POST_CLOSE_DRAIN_MS in the future)
      // hasn't arrived yet.
      await runAlarm(instance);
      expect(readMeta(state, 'metricsEmitted')).not.toBe('true');
      // The deadline is preserved and the alarm is rescheduled to it.
      const pendingDeadline = Number(readMeta(state, 'metricsAlarmAt') ?? '0');
      expect(pendingDeadline).toBeGreaterThan(0);
      const pendingAlarm = await state.storage.getAlarm();
      expect(pendingAlarm).toBe(pendingDeadline);

      // Advance past the metrics deadline and run again: metrics emit.
      vi.advanceTimersByTime(6_000);
      await runAlarm(instance);
      expect(readMeta(state, 'metricsEmitted')).toBe('true');
      expect(readMeta(state, 'metricsAlarmAt')).toBeNull();

      // No outbox work remains, so the alarm is cleared.
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

  // Kilobot finding 5: the absolute dispatch window is bounded at
  // ATTENTION_MAX_DISPATCH_AGE_MS (55min) from `raisedAt` so the row can
  // never cross the receiver's 60min idempotency TTL.
  describe('absolute dispatch window (55min from raisedAt)', () => {
    it('parks a pending row at/over the deadline before claim returns it', async () => {
      const sessionId = trackSession('ses_attention_claim_park_expired');
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      const calls: SendSessionAttentionNotificationParams[] = [];
      await runInDurableObject(stub, async (instance, state) => {
        installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_expired_pending',
          intent: { kind: 'raise', reason: 'question' },
        });
        // Move the row's `raisedAt` and `next_attempt_at` well past the
        // deadline so the next claim is over the window. The claim
        // must park the row as terminal failed and never call the RPC.
        const pastDeadline = Date.now() + 60 * 60 * 1000; // +60min
        state.storage.sql.exec(
          'UPDATE attention_outbox SET raised_at = ?, next_attempt_at = ? WHERE request_id = ?',
          Date.now() - ATTENTION_MAX_DISPATCH_AGE_MS, // 55min ago exactly → at deadline
          pastDeadline,
          'req_expired_pending'
        );

        await runAlarm(instance);

        const row = readOutboxRows(state)[0];
        expect(calls).toHaveLength(0);
        expect(row).toMatchObject({
          request_id: 'req_expired_pending',
          status: 'failed',
          next_attempt_at: null,
          last_error: 'retry_window_expired',
        });
      });
    });

    it('parks a pending row when `now` crosses the deadline even if its next_attempt_at is in the past', async () => {
      // A row whose `next_attempt_at` is in the past but whose
      // `raisedAt` is older than ATTENTION_MAX_DISPATCH_AGE_MS must
      // still be parked, not dispatched.
      const sessionId = trackSession('ses_attention_claim_now_over_deadline');
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      const calls: SendSessionAttentionNotificationParams[] = [];
      await runInDurableObject(stub, async (instance, state) => {
        installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_now_past_deadline',
          intent: { kind: 'raise', reason: 'question' },
        });
        // Force raisedAt deep in the past; keep next_attempt_at < now
        // (so it looks "due") but the deadline has long since passed.
        const longAgo = Date.now() - 24 * 60 * 60 * 1000; // 24h ago
        state.storage.sql.exec(
          'UPDATE attention_outbox SET raised_at = ?, next_attempt_at = ? WHERE request_id = ?',
          longAgo,
          Date.now() - 1,
          'req_now_past_deadline'
        );

        await runAlarm(instance);

        const row = readOutboxRows(state)[0];
        expect(calls).toHaveLength(0);
        expect(row).toMatchObject({
          request_id: 'req_now_past_deadline',
          status: 'failed',
          next_attempt_at: null,
          last_error: 'retry_window_expired',
        });
      });
    });

    it('recovers a stale in_flight row that has crossed the deadline as terminal failed', async () => {
      // Stale recovery must not reschedule a row past the absolute
      // deadline, even if the cap-by-attempt-count would have allowed
      // more attempts.
      const sessionId = trackSession('ses_attention_recover_expired_in_flight');
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      const calls: SendSessionAttentionNotificationParams[] = [];
      await runInDurableObject(stub, async (instance, state) => {
        installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_stale_expired',
          intent: { kind: 'raise', reason: 'question' },
        });
        // Simulate a crash mid-dispatch with a row well past the window.
        state.storage.sql.exec(
          "UPDATE attention_outbox SET status = 'in_flight', raised_at = ?, attempt_count = 1 WHERE request_id = 'req_stale_expired'",
          Date.now() - 2 * 60 * 60 * 1000 // 2h ago
        );

        await runAlarm(instance);

        const row = readOutboxRows(state)[0];
        expect(calls).toHaveLength(0);
        expect(row).toMatchObject({
          request_id: 'req_stale_expired',
          status: 'failed',
          next_attempt_at: null,
          last_error: 'stale_in_flight_recovered',
        });
      });
    });

    it('a retry sequence past the deadline never invokes the RPC and parks the row', async () => {
      // The full integration: the alarm loop runs back-to-back retries
      // until either the cap or the deadline trips. With raises that
      // happened just inside the window, retries must still fall
      // within the window until the cap or the absolute deadline
      // parks the row — the RPC must never be invoked at/after the
      // deadline.
      const sessionId = trackSession('ses_attention_retry_window');
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      const calls: SendSessionAttentionNotificationParams[] = [];
      const raisedAt = Date.now();
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
          requestId: 'req_window',
          intent: { kind: 'raise', reason: 'question' },
        });

        // Run a few retries strictly inside the window. Each advance
        // is small enough to keep us well under the 55min cap.
        for (let i = 0; i < 4; i++) {
          vi.advanceTimersByTime(20_000);
          await runAlarm(instance);
        }
        const beforeDeadline = readOutboxRows(state)[0];
        expect(beforeDeadline?.status).toBe('pending');
        expect(calls.length).toBeGreaterThan(0);

        // Jump past the deadline. The next alarm must NOT call the RPC
        // and must park the row as failed.
        vi.advanceTimersByTime(60 * 60 * 1000); // +60min
        const callsBefore = calls.length;
        await runAlarm(instance);
        const callsAfter = calls.length;
        expect(callsAfter).toBe(callsBefore);

        const row = readOutboxRows(state)[0];
        expect(row).toMatchObject({
          request_id: 'req_window',
          status: 'failed',
          next_attempt_at: null,
        });
        expect(row?.last_error).toBe('retry_window_expired');
        // The deadline is the original raisedAt + 55min, not
        // 'dispatch_failed' (which is the per-retry reason).
        expect(dispatchDeadline(raisedAt)).toBe(raisedAt + ATTENTION_MAX_DISPATCH_AGE_MS);
      });
    });

    it('a delayed alarm past the deadline fails the row without dispatch', async () => {
      // A row was raised, the alarm was lost, and the platform re-fires
      // it well past the deadline. The first claim must park the row
      // and never call the RPC.
      const sessionId = trackSession('ses_attention_delayed_past_deadline');
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      const calls: SendSessionAttentionNotificationParams[] = [];
      await runInDurableObject(stub, async (instance, state) => {
        installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_delayed',
          intent: { kind: 'raise', reason: 'question' },
        });
        // Simulate a long outage: rewind `raised_at` so the row is past
        // its window when the alarm next fires.
        state.storage.sql.exec(
          'UPDATE attention_outbox SET raised_at = ? WHERE request_id = ?',
          Date.now() - 90 * 60 * 1000, // 90min ago
          'req_delayed'
        );

        await runAlarm(instance);

        const row = readOutboxRows(state)[0];
        expect(calls).toHaveLength(0);
        expect(row).toMatchObject({
          request_id: 'req_delayed',
          status: 'failed',
          next_attempt_at: null,
          last_error: 'retry_window_expired',
        });
      });
    });

    it('does not reschedule an alarm that only has expired pending work', async () => {
      // After the alarm body has parked all expired pending rows, the
      // shared scheduler must not keep an alarm alive pointing at a
      // past-deadline time. The next alarm is cleared.
      const sessionId = trackSession('ses_attention_reschedule_no_expired');
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      const calls: SendSessionAttentionNotificationParams[] = [];
      await runInDurableObject(stub, async (instance, state) => {
        installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_expired_alone',
          intent: { kind: 'raise', reason: 'question' },
        });
        state.storage.sql.exec(
          'UPDATE attention_outbox SET raised_at = ?, next_attempt_at = ? WHERE request_id = ?',
          Date.now() - 60 * 60 * 1000,
          Date.now() - 60 * 60 * 1000,
          'req_expired_alone'
        );

        await runAlarm(instance);

        const nextAlarm = await state.storage.getAlarm();
        expect(nextAlarm).toBeNull();
        const row = readOutboxRows(state)[0];
        expect(row?.status).toBe('failed');
      });
    });

    it('initial raise immediate is unaffected: raisedAt === nextAttemptAt is well before the deadline', async () => {
      // A fresh raise sets raisedAt = nextAttemptAt = now. The very
      // first claim must dispatch immediately without hitting the
      // boundary check.
      const sessionId = trackSession('ses_attention_initial_immediate');
      const stub = getStub(kiloUserId, sessionId);
      await seedSession(stub, sessionId);

      const calls: SendSessionAttentionNotificationParams[] = [];
      await runInDurableObject(stub, async (instance, state) => {
        installMocks(instance, makeMockNotifications(calls), makeMockO11Y());
        await instance.recordAttentionEvent({
          kiloUserId,
          sessionId,
          requestId: 'req_immediate',
          intent: { kind: 'raise', reason: 'question' },
        });
        await runAlarm(instance);
        expect(calls).toHaveLength(1);
        const row = readOutboxRows(state)[0];
        expect(row).toMatchObject({
          request_id: 'req_immediate',
          status: 'dispatched',
        });
      });
    });
  });
});
