import { afterEach, beforeEach, describe, expect, it } from '@jest/globals';
import { eq } from 'drizzle-orm';
import { reserveInferenceCredits } from '@kilocode/db/inference-reservations';
import {
  inference_reservations,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_daily,
  microdollar_usage_daily_repairs,
  microdollar_usage_metadata,
} from '@kilocode/db/schema';
import { db } from '@kilocode/web-shared/lib/drizzle';
import {
  createMockUsageContext,
  defineMicrodollarUsage,
} from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import {
  insertUsageRecord,
  parseMicrodollarUsageFromStream,
  parseMicrodollarUsageFromString,
  processTokenData,
} from './processUsage';

let userId: string;
let requestId: string;

beforeEach(async () => {
  const user = await insertTestUser({ total_microdollars_acquired: 100 });
  userId = user.id;
  requestId = crypto.randomUUID();
  await reserveInferenceCredits(db, { requestId, userId, amountMicrodollars: 60 });
});

afterEach(async () => {
  await db.delete(microdollar_usage_metadata).where(eq(microdollar_usage_metadata.id, requestId));
  await db
    .delete(microdollar_usage_daily_repairs)
    .where(eq(microdollar_usage_daily_repairs.kilo_user_id, userId));
  await db.delete(microdollar_usage_daily).where(eq(microdollar_usage_daily.kilo_user_id, userId));
  await db.delete(microdollar_usage).where(eq(microdollar_usage.kilo_user_id, userId));
  await db.delete(inference_reservations).where(eq(inference_reservations.kilo_user_id, userId));
  await db.delete(kilocode_users).where(eq(kilocode_users.id, userId));
});

async function usage(cost: number, final = true) {
  const row = await defineMicrodollarUsage();
  return {
    core: { ...row.core, id: requestId, kilo_user_id: userId, cost },
    metadata: {
      ...row.metadata,
      id: requestId,
      prepaid_reservation_id: requestId,
      prepaid_usage_final: final,
    },
  };
}

async function state() {
  const [user] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));
  const [reservation] = await db
    .select()
    .from(inference_reservations)
    .where(eq(inference_reservations.request_id, requestId));
  return { user, reservation };
}

describe('prepaid usage settlement', () => {
  it('replaces held credit with the actual charge and makes unused credit available', async () => {
    const row = await usage(25);
    expect(await insertUsageRecord(row.core, row.metadata)).not.toBeNull();
    const result = await state();
    expect(result.user).toMatchObject({ microdollars_used: 25, inference_microdollars_held: 0 });
    expect(result.reservation).toMatchObject({ status: 'settled', actual_cost_microdollars: 25 });
    expect(
      await reserveInferenceCredits(db, {
        requestId: crypto.randomUUID(),
        userId,
        amountMicrodollars: 75,
      })
    ).toMatchObject({ kind: 'reserved' });
  });

  it('bills concurrent redelivery once without releasing another request hold', async () => {
    const otherRequestId = crypto.randomUUID();
    await reserveInferenceCredits(db, {
      requestId: otherRequestId,
      userId,
      amountMicrodollars: 30,
    });
    const row = await usage(25);
    await Promise.all([
      insertUsageRecord(row.core, row.metadata),
      insertUsageRecord(row.core, row.metadata),
    ]);
    expect((await state()).user).toMatchObject({
      microdollars_used: 25,
      inference_microdollars_held: 30,
    });
    const rows = await db
      .select({ id: microdollar_usage.id })
      .from(microdollar_usage)
      .where(eq(microdollar_usage.id, requestId));
    expect(rows).toEqual([{ id: requestId }]);
    const [other] = await db
      .select()
      .from(inference_reservations)
      .where(eq(inference_reservations.request_id, otherRequestId));
    expect(other).toMatchObject({ status: 'reserved', amount_microdollars: 30 });
  });

  it('keeps credit held when the actual usage write rolls back', async () => {
    const row = await usage(25);
    row.core.input_tokens = Number.NaN;
    expect(await insertUsageRecord(row.core, row.metadata)).toBeNull();
    const result = await state();
    expect(result.user).toMatchObject({ microdollars_used: 0, inference_microdollars_held: 60 });
    expect(result.reservation).toMatchObject({
      status: 'reserved',
      actual_cost_microdollars: null,
    });
  });

  it('refuses a usage identity that does not belong to its reservation', async () => {
    const row = await usage(25);
    row.core.id = crypto.randomUUID();
    expect(await insertUsageRecord(row.core, row.metadata)).toBeNull();
    expect((await state()).user).toMatchObject({
      microdollars_used: 0,
      inference_microdollars_held: 60,
    });
  });

  it('preserves incurred debt when an upstream charge exceeds its authorized ceiling', async () => {
    const row = await usage(120);
    expect(await insertUsageRecord(row.core, row.metadata)).not.toBeNull();
    const result = await state();
    expect(result.user).toMatchObject({ microdollars_used: 120, inference_microdollars_held: 0 });
    expect(result.reservation).toMatchObject({ status: 'settled', actual_cost_microdollars: 120 });
    expect(
      await reserveInferenceCredits(db, {
        requestId: crypto.randomUUID(),
        userId,
        amountMicrodollars: 1,
      })
    ).toEqual({ kind: 'insufficient' });
  });
});

describe('pending prepaid usage recovery', () => {
  it.each([0, 25])(
    'retains the hold and leaves the authoritative usage identity free for uncertain cost %s',
    async cost => {
      const partial = await usage(cost, false);
      expect(await insertUsageRecord(partial.core, partial.metadata)).toBeNull();
      expect((await state()).user).toMatchObject({
        microdollars_used: 0,
        inference_microdollars_held: 60,
      });
      expect(
        await db.select().from(microdollar_usage).where(eq(microdollar_usage.id, requestId))
      ).toEqual([]);
      const final = await usage(40);
      expect(await insertUsageRecord(final.core, final.metadata)).not.toBeNull();
      expect(await insertUsageRecord(final.core, final.metadata)).not.toBeNull();
      const result = await state();
      expect(result.user).toMatchObject({ microdollars_used: 40, inference_microdollars_held: 0 });
      expect(result.reservation).toMatchObject({ status: 'settled', actual_cost_microdollars: 40 });
    }
  );

  it('does not accept an omitted final-evidence flag on a direct writer call', async () => {
    const row = await usage(25);
    expect(
      await insertUsageRecord(row.core, { ...row.metadata, prepaid_usage_final: undefined })
    ).toBeNull();
    expect((await state()).reservation.status).toBe('reserved');
  });

  it('settles an explicitly authoritative zero charge', async () => {
    const row = await usage(0);
    expect(await insertUsageRecord(row.core, row.metadata)).not.toBeNull();
    const result = await state();
    expect(result.user).toMatchObject({ microdollars_used: 0, inference_microdollars_held: 0 });
    expect(result.reservation).toMatchObject({ status: 'settled', actual_cost_microdollars: 0 });
  });

  it('does not convert a missing nonstream usage object into a final fixed-price zero', async () => {
    const context = createMockUsageContext(userId, '', 0);
    context.provider = 'martian';
    context.requested_model = 'stealth/qwen3.6-plus';
    context.prepaidReservationId = requestId;
    const stats = parseMicrodollarUsageFromString(
      JSON.stringify({
        id: 'upstream-missing-usage',
        model: 'qwen/qwen3.6-plus',
        choices: [{ finish_reason: 'stop', message: { content: 'finished' } }],
      }),
      userId,
      200
    );
    expect(await processTokenData(stats, context)).toBeNull();
    expect((await state()).user).toMatchObject({
      microdollars_used: 0,
      inference_microdollars_held: 60,
    });
    expect(
      await db.select().from(microdollar_usage).where(eq(microdollar_usage.id, requestId))
    ).toEqual([]);
  });

  it('keeps a disconnected Martian stream pending and later settles authoritative full usage once', async () => {
    const context = createMockUsageContext(userId, '', 0);
    context.provider = 'martian';
    context.requested_model = 'stealth/qwen3.6-plus';
    context.prepaidReservationId = requestId;
    context.isStreaming = true;
    let reads = 0;
    const interrupted = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (reads++ === 0)
          controller.enqueue(
            new TextEncoder().encode(
              'data: {"id":"martian-request","model":"qwen/qwen3.6-plus","choices":[{"delta":{"content":"partial"},"finish_reason":null}],"usage":{"prompt_tokens":10,"completion_tokens":2,"total_tokens":12}}\n\n'
            )
          );
        else controller.error(new Error('upstream disconnected'));
      },
    });
    const partial = await parseMicrodollarUsageFromStream(
      interrupted,
      userId,
      undefined,
      'martian',
      200
    );
    expect(partial.hasFinalTokenUsage).toBe(false);
    expect(await processTokenData(partial, context)).toBeNull();
    expect((await state()).user).toMatchObject({
      microdollars_used: 0,
      inference_microdollars_held: 60,
    });
    const final = parseMicrodollarUsageFromString(
      JSON.stringify({
        id: 'martian-request',
        model: 'qwen/qwen3.6-plus',
        choices: [{ finish_reason: 'stop', message: { content: 'complete' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
      userId,
      200
    );
    expect(final.hasFinalTokenUsage).toBe(true);
    expect(final.hasFinalCost).toBe(false);
    expect(await processTokenData(final, context)).not.toBeNull();
    expect(await processTokenData(final, context)).not.toBeNull();
    const result = await state();
    expect(result.user).toMatchObject({ microdollars_used: 10, inference_microdollars_held: 0 });
    expect(result.reservation).toMatchObject({ status: 'settled', actual_cost_microdollars: 10 });
  });
});
