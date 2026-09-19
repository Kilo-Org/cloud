import { afterEach, describe, expect, it } from '@jest/globals';
import type { InternalDispatchSpendAlertRequest } from '@kilocode/notifications';
import { eq, inArray } from 'drizzle-orm';
import { db } from '@/lib/drizzle';
import { spend_alert_deliveries } from '@kilocode/db/schema';
import { drainPendingSpendAlertDeliveries, type SpendAlertDeliveryDeps } from './delivery';

type EmailInput = Parameters<SpendAlertDeliveryDeps['sendEmail']>[0];
type PushInput = Parameters<SpendAlertDeliveryDeps['dispatchPush']>[0];

const OWNER_USER_ID = 'owner-spend-alerts-s5';
const PERSONAL_SCOPE_KEY = `user:${OWNER_USER_ID}`;
const DELIVERY_PAYLOAD = {
  valueMicrodollars: 5_000_000,
  thresholdMicrodollars: 5_000_000,
  windowHours: 24,
  multiplierBasisPoints: null,
  baselineHourlyMicrodollars: null,
};

const createdDeliveryIds: string[] = [];

/**
 * A due pending row. Other suites share this table, so each test asserts on
 * its own rows and its own scope rather than on the drain's global totals.
 */
async function insertDelivery(
  overrides: Partial<typeof spend_alert_deliveries.$inferInsert> = {}
): Promise<string> {
  const [row] = await db
    .insert(spend_alert_deliveries)
    .values({
      dedupe_key: `s5-test:${crypto.randomUUID()}`,
      scope_key: PERSONAL_SCOPE_KEY,
      kind: 'threshold',
      channel: 'email',
      fired_at: new Date().toISOString(),
      recipients: { userIds: [], emails: ['owner@example.com'] },
      payload: DELIVERY_PAYLOAD,
      status: 'pending',
      attempt_count: 0,
      next_attempt_at: new Date(Date.now() - 60_000).toISOString(),
      ...overrides,
    })
    .returning({ id: spend_alert_deliveries.id });
  createdDeliveryIds.push(row.id);
  return row.id;
}

async function readDelivery(id: string) {
  const [row] = await db
    .select()
    .from(spend_alert_deliveries)
    .where(eq(spend_alert_deliveries.id, id));
  return row;
}

function recordingDeps(overrides: Partial<SpendAlertDeliveryDeps> = {}): {
  deps: SpendAlertDeliveryDeps;
  emails: EmailInput[];
  pushes: PushInput[];
} {
  const emails: EmailInput[] = [];
  const pushes: PushInput[] = [];
  const deps: SpendAlertDeliveryDeps = {
    sendEmail: async input => {
      emails.push(input);
      return { delivered: input.to, retryable: [], undeliverable: [] };
    },
    dispatchPush: async input => {
      pushes.push(input);
      return true;
    },
    ...overrides,
  };
  return { deps, emails, pushes };
}

/** A database whose `execute` rejects whenever the statement contains `fragment`. */
function databaseFailingOn(fragment: string): typeof db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (query: unknown, ...args: unknown[]) => {
          if (sqlText(query).includes(fragment)) {
            return Promise.reject(new Error('database unavailable'));
          }
          const execute = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
          return Reflect.apply(execute, target, [query, ...args]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as typeof db;
}

/** A database whose `execute` rejects the first `times` statements containing `fragment`. */
function databaseFailingOnFirst(fragment: string, times: number): typeof db {
  let remaining = times;
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (query: unknown, ...args: unknown[]) => {
          if (remaining > 0 && sqlText(query).includes(fragment)) {
            remaining -= 1;
            return Promise.reject(new Error('database unavailable'));
          }
          const execute = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
          return Reflect.apply(execute, target, [query, ...args]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as typeof db;
}

/** A database that records the SQL text of every statement it executes. */
function databaseRecordingQueries(queries: string[]): typeof db {
  return new Proxy(db, {
    get(target, prop, receiver) {
      if (prop === 'execute') {
        return (query: unknown, ...args: unknown[]) => {
          queries.push(sqlText(query));
          const execute = Reflect.get(target, prop, receiver) as (...a: unknown[]) => unknown;
          return Reflect.apply(execute, target, [query, ...args]);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function'
        ? (value as (...a: unknown[]) => unknown).bind(target)
        : value;
    },
  }) as typeof db;
}

function sqlText(value: unknown): string {
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(sqlText).join('');
  if (value && typeof value === 'object') {
    const record = value as { queryChunks?: unknown; value?: unknown };
    if (record.queryChunks) return sqlText(record.queryChunks);
    if (record.value) return sqlText(record.value);
  }
  return '';
}

afterEach(async () => {
  if (createdDeliveryIds.length > 0) {
    await db
      .delete(spend_alert_deliveries)
      .where(inArray(spend_alert_deliveries.id, createdDeliveryIds));
    createdDeliveryIds.length = 0;
  }
});

describe('drainPendingSpendAlertDeliveries', () => {
  it('sends an email and a push and marks both rows sent with one attempt', async () => {
    const emailId = await insertDelivery({ channel: 'email' });
    const pushId = await insertDelivery({
      channel: 'push',
      dedupe_key: 's5-push-episode-1',
      recipients: { userIds: [OWNER_USER_ID], emails: [] },
    });
    const { deps, emails, pushes } = recordingDeps();

    await drainPendingSpendAlertDeliveries(db, deps, { limit: 10 });

    const emailed = emails.filter(input => input.scopeId === OWNER_USER_ID);
    expect(emailed).toHaveLength(1);
    expect(emailed[0]).toMatchObject({
      to: ['owner@example.com'],
      scopeType: 'personal',
      scopeId: OWNER_USER_ID,
      scopeName: 'Your account',
      kindLabel: 'Spend threshold',
      amountUsd: 5,
      thresholdUsd: 5,
    });

    const pushed = pushes.filter(input => input.recipientUserIds.includes(OWNER_USER_ID));
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toEqual({
      recipientUserIds: [OWNER_USER_ID],
      scope: 'personal',
      alertKind: 'threshold',
      scopeName: 'Your account',
      amountUsd: 5,
      thresholdUsd: 5,
      // The outbox row's own key carries the firing episode to the push
      // idempotency key, so a later crossing is not collapsed into this one.
      dedupeKey: 's5-push-episode-1',
    } satisfies Omit<InternalDispatchSpendAlertRequest, 'kind'>);

    for (const id of [emailId, pushId]) {
      const row = await readDelivery(id);
      expect(row?.status).toBe('sent');
      expect(row?.attempt_count).toBe(1);
      expect(row?.last_error_redacted).toBeNull();
    }
  });

  it('keeps a transport failure pending with a later next_attempt_at and an incremented count', async () => {
    const id = await insertDelivery({ channel: 'email' });
    const before = await readDelivery(id);
    const { deps } = recordingDeps({
      sendEmail: async () => {
        throw new Error('mailgun transport failed');
      },
    });

    const summary = await drainPendingSpendAlertDeliveries(db, deps, { limit: 10 });

    expect(summary.failed).toContainEqual({
      deliveryId: id,
      channel: 'email',
      error: 'spend_alert_email_delivery_failed',
    });

    const after = await readDelivery(id);
    expect(after?.status).toBe('pending');
    expect(after?.attempt_count).toBe(1);
    expect(new Date(String(after?.next_attempt_at)).getTime()).toBeGreaterThan(
      new Date(String(before?.next_attempt_at)).getTime()
    );
    expect(after?.last_error_redacted).toBe('spend_alert_email_delivery_failed');
  });

  it('retries only the recipients a partial transport failure did not reach', async () => {
    const id = await insertDelivery({
      channel: 'email',
      recipients: { userIds: [], emails: ['a@example.com', 'b@example.com'] },
    });
    const { deps } = recordingDeps({
      sendEmail: async () => ({
        delivered: ['a@example.com'],
        retryable: ['b@example.com'],
        undeliverable: [],
      }),
    });

    const summary = await drainPendingSpendAlertDeliveries(db, deps, { limit: 10 });

    expect(summary.delivered).toBe(0);
    expect(summary.failed).toContainEqual({
      deliveryId: id,
      channel: 'email',
      error: 'spend_alert_email_delivery_failed',
    });

    // The row is retried, but no longer names the recipient who already got the
    // alert, so the retry cannot email them a second time.
    const after = await readDelivery(id);
    expect(after?.status).toBe('pending');
    expect(after?.last_error_redacted).toBe('spend_alert_email_delivery_failed');
    expect(after?.recipients).toEqual({ userIds: [], emails: ['b@example.com'] });
  });

  it('does not requeue a row with recipients it already reached when the narrowing write fails', async () => {
    const id = await insertDelivery({
      channel: 'email',
      recipients: { userIds: [], emails: ['a@example.com', 'b@example.com'] },
    });
    const sends: EmailInput[] = [];
    const { deps } = recordingDeps({
      sendEmail: async input => {
        sends.push(input);
        return { delivered: ['a@example.com'], retryable: ['b@example.com'], undeliverable: [] };
      },
    });
    // The write that narrows the row to the recipients the attempt did not reach
    // fails; a@example.com already received the alert.
    const flakyDb = databaseFailingOn('jsonb_set');

    const summary = await drainPendingSpendAlertDeliveries(flakyDb, deps, { limit: 10 });

    expect(summary.delivered).toBe(0);
    expect(summary.failed).toContainEqual({
      deliveryId: id,
      channel: 'email',
      error: 'spend_alert_email_delivery_failed',
    });

    // The row must not stay pending with the full recipient list: a later drain
    // would email a@example.com the same alert a second time.
    const after = await readDelivery(id);
    expect(after?.status).toBe('failed');
    expect(after?.last_error_redacted).toBe('spend_alert_delivery_narrow_failed');

    await drainPendingSpendAlertDeliveries(db, deps, { limit: 10 });
    expect(sends.filter(input => input.scopeId === OWNER_USER_ID)).toHaveLength(1);
  });

  it('retries the narrowing write so a transient failure still narrows the retry', async () => {
    const id = await insertDelivery({
      channel: 'email',
      recipients: { userIds: [], emails: ['a@example.com', 'b@example.com'] },
    });
    const sends: EmailInput[] = [];
    const { deps } = recordingDeps({
      sendEmail: async input => {
        sends.push(input);
        return { delivered: ['a@example.com'], retryable: ['b@example.com'], undeliverable: [] };
      },
    });
    // The narrowing+reschedule write fails once, then succeeds.
    const flakyDb = databaseFailingOnFirst('jsonb_set', 1);

    await drainPendingSpendAlertDeliveries(flakyDb, deps, { limit: 10 });

    const after = await readDelivery(id);
    expect(after?.status).toBe('pending');
    expect(after?.recipients).toEqual({ userIds: [], emails: ['b@example.com'] });
    expect(sends.filter(input => input.scopeId === OWNER_USER_ID)).toHaveLength(1);
  });

  it('does not retry a permanently rejected recipient', async () => {
    const id = await insertDelivery({ channel: 'email' });
    const { deps } = recordingDeps({
      sendEmail: async () => ({
        delivered: [],
        retryable: [],
        undeliverable: ['owner@example.com'],
      }),
    });

    const summary = await drainPendingSpendAlertDeliveries(db, deps, { limit: 10 });

    expect(summary.delivered).toBe(0);
    expect(summary.failed).toContainEqual({
      deliveryId: id,
      channel: 'email',
      error: 'spend_alert_email_undeliverable',
    });

    // A rejection that can never succeed must leave the retry queue, not spin.
    const after = await readDelivery(id);
    expect(after?.status).toBe('failed');
    expect(after?.last_error_redacted).toBe('spend_alert_email_undeliverable');
  });

  it('reschedules a push the worker refused', async () => {
    const id = await insertDelivery({
      channel: 'push',
      recipients: { userIds: [OWNER_USER_ID], emails: [] },
    });
    const { deps } = recordingDeps({
      dispatchPush: async () => false,
    });

    const summary = await drainPendingSpendAlertDeliveries(db, deps, { limit: 10 });

    expect(summary.delivered).toBe(0);
    expect(summary.failed).toContainEqual({
      deliveryId: id,
      channel: 'push',
      error: 'spend_alert_push_delivery_failed',
    });
    expect((await readDelivery(id))?.status).toBe('pending');
  });

  it('does not mark a row with no recipients sent', async () => {
    const id = await insertDelivery({ channel: 'email', recipients: { userIds: [], emails: [] } });
    const { deps, emails } = recordingDeps();

    const summary = await drainPendingSpendAlertDeliveries(db, deps, { limit: 10 });

    expect(emails).toHaveLength(0);
    expect(summary.delivered).toBe(0);
    expect(summary.failed).toContainEqual({
      deliveryId: id,
      channel: 'email',
      error: 'spend_alert_delivery_no_recipients',
    });

    // An alert nobody can receive is not delivered, and waiting will not make an
    // address appear: it leaves the pending queue instead of spinning.
    const after = await readDelivery(id);
    expect(after?.status).toBe('failed');
    expect(after?.last_error_redacted).toBe('spend_alert_delivery_no_recipients');
  });

  it('ends a row whose shape can never be delivered instead of rescheduling it forever', async () => {
    const unknownScopeId = await insertDelivery({ scope_key: 'not-a-scope' });
    const unknownKindId = await insertDelivery({ kind: null });
    const missingPayloadId = await insertDelivery({ payload: null });
    const unknownChannelId = await insertDelivery({
      // The column is a plain `text` with a TypeScript-only union, so a legacy
      // or out-of-band row can hold a channel the drain does not know.
      channel: 'sms' as 'email',
    });
    const { deps, emails, pushes } = recordingDeps();

    const summary = await drainPendingSpendAlertDeliveries(db, deps, { limit: 20 });

    expect(emails).toHaveLength(0);
    expect(pushes).toHaveLength(0);
    const errors = summary.failed.map(failure => failure.error);
    expect(errors).toContain('spend_alert_delivery_unknown_scope');
    expect(errors).toContain('spend_alert_delivery_unknown_kind');
    expect(errors).toContain('spend_alert_delivery_missing_payload');
    expect(errors).toContain('spend_alert_delivery_unknown_channel');

    // A malformed row leaves the queue: only a transient failure is rescheduled,
    // so the drain does not retry an undeliverable row on every cron.
    const cases = [
      [unknownScopeId, 'spend_alert_delivery_unknown_scope'],
      [unknownKindId, 'spend_alert_delivery_unknown_kind'],
      [missingPayloadId, 'spend_alert_delivery_missing_payload'],
      [unknownChannelId, 'spend_alert_delivery_unknown_channel'],
    ] as const;
    for (const [id, token] of cases) {
      const row = await readDelivery(id);
      expect(row?.status).toBe('failed');
      expect(row?.last_error_redacted).toBe(token);
    }
  });

  it('claims due rows in the pending index order so the claim needs no sort', async () => {
    await insertDelivery({ channel: 'email' });
    const { deps } = recordingDeps();
    const queries: string[] = [];

    await drainPendingSpendAlertDeliveries(databaseRecordingQueries(queries), deps, { limit: 10 });

    const claim = queries.find(text => text.includes('FOR UPDATE SKIP LOCKED'));
    expect(claim).toBeDefined();
    // The order matches IDX_spend_alert_deliveries_pending
    // (status, next_attempt_at, attempt_count, id) after the status equality, so
    // Postgres reads the due rows in index order instead of sorting the whole
    // due set before LIMIT.
    expect(claim).toContain(
      'ORDER BY delivery.next_attempt_at, delivery.attempt_count, delivery.id'
    );
  });

  it('never leaves a delivered row claimable when recording the send fails', async () => {
    const id = await insertDelivery({ channel: 'email' });
    const { deps, emails } = recordingDeps();
    // The mark that records a successful send fails; the alert is already out.
    const flakyDb = databaseFailingOn("status = 'sent'");

    const summary = await drainPendingSpendAlertDeliveries(flakyDb, deps, { limit: 10 });

    expect(emails.filter(input => input.scopeId === OWNER_USER_ID)).toHaveLength(1);
    expect(summary.failed).toContainEqual({
      deliveryId: id,
      channel: 'email',
      error: 'spend_alert_delivery_mark_failed',
    });

    // The row is terminal, not pending: the next drain cannot re-claim it and
    // send the alert a second time.
    const after = await readDelivery(id);
    expect(after?.status).toBe('failed');
    expect(after?.last_error_redacted).toBe('spend_alert_delivery_mark_failed');
  });

  it('leases a claimed row so a concurrent drain cannot send it twice', async () => {
    const id = await insertDelivery({ channel: 'email' });
    const { deps, emails } = recordingDeps();

    const [first, second] = await Promise.all([
      drainPendingSpendAlertDeliveries(db, deps, { limit: 10 }),
      drainPendingSpendAlertDeliveries(db, deps, { limit: 10 }),
    ]);

    // The lease is `next_attempt_at`: the loser of the claim sees no candidate.
    expect(emails.filter(input => input.scopeId === OWNER_USER_ID)).toHaveLength(1);

    const after = await readDelivery(id);
    expect(after?.status).toBe('sent');
    expect(after?.attempt_count).toBe(1);
    expect(first.claimed + second.claimed).toBeGreaterThanOrEqual(1);
  });
});
