import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, describe, expect, test } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { NextRequest } from 'next/server';

import { POST } from './route';
import { INTERNAL_API_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { deliverUsageEventWireBody } from '@kilocode/web-shared/lib/bouncer/client';
import { dispatchQueuedBouncerUsageEvents } from '@kilocode/web-shared/lib/bouncer/dispatch-usage-event-outbox';
import { defineMicrodollarUsage } from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  bouncer_usage_event_outbox,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { UsageRecordRequestSchema, type UsageRecordRequest } from '@kilocode/usage-contracts';

jest.mock('@kilocode/web-shared/lib/bouncer/client', () => ({
  ...jest.requireActual('@kilocode/web-shared/lib/bouncer/client'),
  deliverUsageEventWireBody: jest.fn(),
}));

const deliver = jest.mocked(deliverUsageEventWireBody);

async function fixture(): Promise<UsageRecordRequest> {
  const user = await insertTestUser({ microdollars_used: 0 });
  const usage = await defineMicrodollarUsage();
  const requestId = randomUUID();
  return UsageRecordRequestSchema.parse({
    ...usage,
    core: { ...usage.core, kilo_user_id: user.id, cost: 700 },
    metadata: { ...usage.metadata, created_at: usage.core.created_at },
    prior_microdollar_usage: 0,
    posthog_distinct_id: null,
    bouncer_usage_event: {
      request_id: requestId,
      payload: { requestId, accountId: `user:${user.id}`, costMicrodollars: 700 },
    },
  });
}

async function write(payload: UsageRecordRequest) {
  const response = await POST(
    new NextRequest('http://localhost/api/internal/usage/record', {
      method: 'POST',
      headers: { 'x-internal-api-key': INTERNAL_API_SECRET },
      body: JSON.stringify(payload),
    })
  );
  expect(response.status).toBe(200);
  return response.json();
}

async function outboxRow(payload: UsageRecordRequest) {
  const [row] = await db
    .select()
    .from(bouncer_usage_event_outbox)
    .where(
      eq(bouncer_usage_event_outbox.request_id, payload.bouncer_usage_event?.request_id ?? '')
    );
  return row;
}

async function expectOneCharge(payload: UsageRecordRequest) {
  expect(
    await db.select().from(microdollar_usage).where(eq(microdollar_usage.id, payload.core.id))
  ).toHaveLength(1);
  expect(
    await db
      .select()
      .from(microdollar_usage_metadata)
      .where(eq(microdollar_usage_metadata.id, payload.core.id))
  ).toHaveLength(1);
  const [user] = await db
    .select()
    .from(kilocode_users)
    .where(eq(kilocode_users.id, payload.core.kilo_user_id));
  expect(user?.microdollars_used).toBe(700);
}

beforeEach(() => {
  deliver.mockReset();
  deliver.mockResolvedValue({ delivered: true, status: 204 });
});
afterEach(() => {
  jest.restoreAllMocks();
});

describe('usage writer post-commit Bouncer delivery', () => {
  test('the writer delivers immediately with committed usage, balance and outbox visible', async () => {
    const payload = await fixture();
    deliver.mockImplementation(async body => {
      // These independent pool queries cannot see an uncommitted usage transaction.
      await expectOneCharge(payload);
      expect((await outboxRow(payload))?.status).toBe('sending');
      expect(body).toEqual(payload.bouncer_usage_event?.payload);
      return { delivered: true, status: 204 };
    });

    expect(await write(payload)).toMatchObject({
      status: 'recorded',
      result: { usageId: payload.core.id, newMicrodollarsUsed: 700 },
    });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await outboxRow(payload))?.status).toBe('delivered');

    expect(await write(payload)).toMatchObject({ status: 'duplicate' });
    expect(deliver).toHaveBeenCalledTimes(1);
    await expectOneCharge(payload);
  });

  test('Bouncer unavailability keeps the write successful and leaves retry to the drainer', async () => {
    const payload = await fixture();
    deliver.mockResolvedValueOnce({
      delivered: false,
      permanent: false,
      status: 503,
      error: 'http_503',
    });

    expect(await write(payload)).toMatchObject({ status: 'recorded' });
    expect(await outboxRow(payload)).toMatchObject({ status: 'pending', attempts: 1 });
    await expectOneCharge(payload);

    expect(await write(payload)).toMatchObject({ status: 'duplicate' });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(await outboxRow(payload)).toMatchObject({ status: 'pending', attempts: 1 });

    // Make this row due as it would be on the cron pass after its backoff.
    await db
      .update(bouncer_usage_event_outbox)
      .set({ next_attempt_at: null })
      .where(eq(bouncer_usage_event_outbox.request_id, payload.bouncer_usage_event!.request_id));
    const summary = await dispatchQueuedBouncerUsageEvents({ limit: 10 });
    expect(summary.delivered).toBe(1);
    expect(deliver).toHaveBeenCalledTimes(2);
    expect((await outboxRow(payload))?.status).toBe('delivered');
    await expectOneCharge(payload);
  });

  test('concurrent duplicate writer calls charge and deliver once', async () => {
    const payload = await fixture();
    const results = await Promise.all([write(payload), write(payload)]);
    expect(results.map(result => result.status).sort()).toEqual(['duplicate', 'recorded']);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect((await outboxRow(payload))?.status).toBe('delivered');
    await expectOneCharge(payload);
  });

  test('a failed usage transaction never attempts delivery', async () => {
    const payload = await fixture();
    jest
      .spyOn(db, 'transaction')
      .mockRejectedValue(
        Object.assign(new Error('synthetic transaction failure'), { code: '23514' })
      );
    jest.spyOn(console, 'error').mockImplementation(() => {});

    expect(await write(payload)).toEqual({ status: 'not_recorded', result: null });
    expect(deliver).not.toHaveBeenCalled();
    expect(await outboxRow(payload)).toBeUndefined();
    expect(
      await db.select().from(microdollar_usage).where(eq(microdollar_usage.id, payload.core.id))
    ).toHaveLength(0);
  });

  test('usage without a Bouncer outbox event performs no delivery', async () => {
    const payload = { ...(await fixture()), bouncer_usage_event: null };
    expect(await write(payload)).toMatchObject({ status: 'recorded' });
    expect(deliver).not.toHaveBeenCalled();
    await expectOneCharge(payload);
  });
});
