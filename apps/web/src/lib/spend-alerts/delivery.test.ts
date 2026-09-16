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
    },
    dispatchPush: async input => {
      pushes.push(input);
    },
    ...overrides,
  };
  return { deps, emails, pushes };
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
