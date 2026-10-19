import { afterEach, beforeAll, beforeEach, describe, expect, it } from '@jest/globals';
import { eq, inArray } from 'drizzle-orm';
import {
  releaseInferenceCredits,
  reserveInferenceCredits,
} from '@kilocode/db/inference-reservations';
import {
  bouncer_usage_event_outbox,
  http_user_agent,
  inference_reservations,
  kilocode_users,
  microdollar_usage,
  microdollar_usage_daily,
  microdollar_usage_daily_repairs,
  microdollar_usage_metadata,
  organization_memberships,
  organization_user_usage,
  organizations,
} from '@kilocode/db/schema';
import { db, pool } from '@kilocode/web-shared/lib/drizzle';
import {
  createMockUsageContext,
  defineMicrodollarUsage,
} from '@kilocode/web-shared/tests/helpers/microdollar-usage.helper';
import { insertTestUser } from '@kilocode/web-shared/tests/helpers/user.helper';
import { createTestOrganization } from '@kilocode/web-shared/tests/helpers/organization.helper';
import type { UsageRecordWriteOutcome } from './processUsage.types';
import {
  insertUsageRecord,
  parseMicrodollarUsageFromStream,
  parseMicrodollarUsageFromString,
  processTokenData,
} from './processUsage';

let userId: string;
let requestId: string;
let organizationId: string | undefined;
let coldUserAgent: string | undefined;

beforeAll(async () => {
  Object.assign(pool.options, { pipeline: true });
  const client = await pool.connect();
  try {
    if (!('pipeline' in client) || client.pipeline !== true) {
      throw new Error('Settlement regressions require native query pipelining');
    }
  } finally {
    client.release();
  }
});

beforeEach(async () => {
  organizationId = undefined;
  coldUserAgent = undefined;
  const user = await insertTestUser({ total_microdollars_acquired: 100 });
  userId = user.id;
  requestId = crypto.randomUUID();
  await reserveInferenceCredits(db, { requestId, userId, amountMicrodollars: 60 });
});

afterEach(async () => {
  await db
    .delete(microdollar_usage_metadata)
    .where(
      inArray(
        microdollar_usage_metadata.id,
        db
          .select({ id: microdollar_usage.id })
          .from(microdollar_usage)
          .where(eq(microdollar_usage.kilo_user_id, userId))
      )
    );
  if (coldUserAgent) {
    await db.delete(http_user_agent).where(eq(http_user_agent.http_user_agent, coldUserAgent));
  }
  await db.delete(bouncer_usage_event_outbox).where(eq(bouncer_usage_event_outbox.user_id, userId));
  await db
    .delete(microdollar_usage_daily_repairs)
    .where(eq(microdollar_usage_daily_repairs.kilo_user_id, userId));
  await db.delete(microdollar_usage_daily).where(eq(microdollar_usage_daily.kilo_user_id, userId));
  await db.delete(microdollar_usage).where(eq(microdollar_usage.kilo_user_id, userId));
  await db.delete(inference_reservations).where(eq(inference_reservations.kilo_user_id, userId));
  if (organizationId) {
    await db
      .delete(organization_user_usage)
      .where(eq(organization_user_usage.organization_id, organizationId));
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, organizationId));
    await db.delete(organizations).where(eq(organizations.id, organizationId));
  }
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

type UsageLockWait = {
  pid: number;
  blocked_by: number[];
  locktype: string;
  transaction_id: string | null;
  backend_xid: string;
};

async function waitForUsageLock(blockerPids: number[], excludedPids: number[] = []) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await pool.query<UsageLockWait>(
      `
        SELECT activity.pid, pg_blocking_pids(activity.pid) AS blocked_by,
          locks.locktype, locks.transactionid::text AS transaction_id,
          activity.backend_xid::text AS backend_xid
        FROM pg_stat_activity activity
        JOIN pg_locks locks ON locks.pid = activity.pid AND NOT locks.granted
        WHERE activity.datname = current_database()
          AND activity.wait_event_type = 'Lock'
          AND pg_blocking_pids(activity.pid) && $1::integer[]
          AND activity.pid <> ALL($2::integer[])
      `,
      [blockerPids, excludedPids]
    );
    if (rows.length === 1) return rows[0];
    if (rows.length > 1) throw new Error('Multiple usage transactions reached the lock barrier');
  }
  throw new Error('Usage transaction did not reach the PostgreSQL lock barrier');
}

describe('prepaid usage settlement', () => {
  it('replaces held credit with the actual charge and makes unused credit available', async () => {
    const row = await usage(25);
    expect(await insertUsageRecord(row.core, row.metadata)).toMatchObject({
      newMicrodollarsUsed: 25,
    });
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

  it('orders mixed cold-metadata writes before the payer without leaking holds', async () => {
    const otherRequestId = crypto.randomUUID();
    await reserveInferenceCredits(db, {
      requestId: otherRequestId,
      userId,
      amountMicrodollars: 30,
    });
    coldUserAgent = `prepaid-cold-metadata-${crypto.randomUUID()}`;
    const reserved = await usage(25);
    reserved.metadata = {
      ...reserved.metadata,
      http_user_agent: coldUserAgent,
      http_x_forwarded_for: null,
      http_x_vercel_ip_city: null,
      http_x_vercel_ip_country: null,
      http_x_vercel_ja4_digest: null,
      system_prompt_prefix: null,
      finish_reason: null,
      editor_name: null,
      api_kind: null,
      feature: null,
      mode: null,
      auto_model: null,
      reasoning_setting: null,
    };
    const legacyId = crypto.randomUUID();
    const legacy = {
      core: { ...reserved.core, id: legacyId, cost: 15 },
      metadata: {
        ...reserved.metadata,
        id: legacyId,
        prepaid_reservation_id: undefined,
        prepaid_usage_final: undefined,
      },
    };
    expect(
      await db
        .select()
        .from(http_user_agent)
        .where(eq(http_user_agent.http_user_agent, coldUserAgent))
    ).toEqual([]);

    const blocker = await pool.connect();
    let legacyWrite: Promise<UsageRecordWriteOutcome | null> | undefined;
    let reservedWrite: Promise<UsageRecordWriteOutcome | null> | undefined;
    let blockerOpen = false;
    try {
      await blocker.query('BEGIN');
      blockerOpen = true;
      const {
        rows: [{ pid: blockerPid }],
      } = await blocker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      await blocker.query('SELECT id FROM kilocode_users WHERE id = $1 FOR NO KEY UPDATE', [
        userId,
      ]);
      legacyWrite = insertUsageRecord(legacy.core, legacy.metadata);
      const legacyWait = await waitForUsageLock([blockerPid]);
      reservedWrite = insertUsageRecord(reserved.core, reserved.metadata);
      const reservedWait = await waitForUsageLock([blockerPid, legacyWait.pid], [legacyWait.pid]);
      expect(reservedWait).toMatchObject({
        blocked_by: [legacyWait.pid],
        locktype: 'transactionid',
        transaction_id: legacyWait.backend_xid,
      });
      await blocker.query('COMMIT');
      blockerOpen = false;
      const [legacyResult, reservedResult] = await Promise.all([legacyWrite, reservedWrite]);
      expect(legacyResult).toMatchObject({ newMicrodollarsUsed: 15, wasRedelivery: false });
      expect(reservedResult).toMatchObject({ newMicrodollarsUsed: 40, wasRedelivery: false });
      const result = await state();
      expect(result.user).toMatchObject({ microdollars_used: 40, inference_microdollars_held: 30 });
      expect(result.reservation).toMatchObject({ status: 'settled', actual_cost_microdollars: 25 });
      const [other] = await db
        .select()
        .from(inference_reservations)
        .where(eq(inference_reservations.request_id, otherRequestId));
      expect(other).toMatchObject({ status: 'reserved', amount_microdollars: 30 });
      const usageRows = await db
        .select({ id: microdollar_usage.id })
        .from(microdollar_usage)
        .where(eq(microdollar_usage.kilo_user_id, userId));
      expect(usageRows.map(row => row.id).sort()).toEqual([legacyId, requestId].sort());
      const metadataRows = await db
        .select({
          id: microdollar_usage_metadata.id,
          userAgentId: microdollar_usage_metadata.http_user_agent_id,
        })
        .from(microdollar_usage_metadata)
        .where(inArray(microdollar_usage_metadata.id, [legacyId, requestId]));
      expect(metadataRows).toHaveLength(2);
      expect(metadataRows[0].userAgentId).toEqual(expect.any(Number));
      expect(metadataRows[1].userAgentId).toBe(metadataRows[0].userAgentId);
    } finally {
      if (blockerOpen) await blocker.query('ROLLBACK');
      blocker.release();
      await Promise.allSettled([legacyWrite, reservedWrite]);
    }
  }, 30_000);

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

  it('rolls back reserved usage and settlement when its outbox insert fails', async () => {
    const row = await usage(25);
    expect(
      await insertUsageRecord(row.core, row.metadata, {
        request_id: 'invalid\u0000request',
        payload: {},
      })
    ).toBeNull();
    const result = await state();
    expect(result.user).toMatchObject({ microdollars_used: 0, inference_microdollars_held: 60 });
    expect(result.reservation).toMatchObject({
      status: 'reserved',
      actual_cost_microdollars: null,
    });
    expect(
      await db.select().from(microdollar_usage).where(eq(microdollar_usage.id, requestId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(microdollar_usage_metadata)
        .where(eq(microdollar_usage_metadata.id, requestId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(microdollar_usage_daily_repairs)
        .where(eq(microdollar_usage_daily_repairs.kilo_user_id, userId))
    ).toEqual([]);
    expect(
      await db
        .select()
        .from(bouncer_usage_event_outbox)
        .where(eq(bouncer_usage_event_outbox.user_id, userId))
    ).toEqual([]);
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

  it('records already-incurred legacy organization spend even when its held counter needs repair', async () => {
    const organization = await createTestOrganization('Legacy usage', userId, 100);
    organizationId = organization.id;
    await db
      .update(organizations)
      .set({ inference_microdollars_held: -1 })
      .where(eq(organizations.id, organizationId));
    const row = await usage(25);
    const legacyId = crypto.randomUUID();
    expect(
      await insertUsageRecord(
        { ...row.core, id: legacyId, organization_id: organizationId },
        { ...row.metadata, id: legacyId, prepaid_reservation_id: null, prepaid_usage_final: false }
      )
    ).toMatchObject({ wasRedelivery: false });
    const [payer] = await db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(payer).toMatchObject({
      microdollars_used: 25,
      microdollars_balance: 75,
      inference_microdollars_held: -1,
    });
    const [member] = await db
      .select()
      .from(organization_user_usage)
      .where(eq(organization_user_usage.organization_id, organizationId));
    expect(member.microdollar_usage).toBe(25);
    expect((await state()).user.inference_microdollars_held).toBe(60);
  });

  it.each([0, 25, 120])(
    'settles organization cost %s with member usage and a combined payer debit',
    async cost => {
      const organization = await createTestOrganization('Prepaid usage', userId, 100);
      organizationId = organization.id;
      await db.transaction(tx => releaseInferenceCredits(tx, { requestId, userId }));
      requestId = crypto.randomUUID();
      await reserveInferenceCredits(db, {
        requestId,
        userId,
        organizationId,
        amountMicrodollars: 60,
      });
      const row = await usage(cost);
      row.core.organization_id = organizationId;
      expect(await insertUsageRecord(row.core, row.metadata)).toMatchObject({
        newMicrodollarsUsed: null,
      });
      expect(await insertUsageRecord(row.core, row.metadata)).not.toBeNull();
      const [payer] = await db
        .select()
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      expect(payer).toMatchObject({
        microdollars_used: cost,
        microdollars_balance: 100 - cost,
        inference_microdollars_held: 0,
      });
      const memberUsage = await db
        .select()
        .from(organization_user_usage)
        .where(eq(organization_user_usage.organization_id, organizationId));
      expect(memberUsage).toEqual(
        cost === 0
          ? []
          : [expect.objectContaining({ kilo_user_id: userId, microdollar_usage: cost })]
      );
      const result = await state();
      expect(result.user).toMatchObject({ microdollars_used: 0, inference_microdollars_held: 0 });
      expect(result.reservation).toMatchObject({
        status: 'settled',
        actual_cost_microdollars: cost,
      });
    }
  );

  it('settles an empty reservation without releasing another request hold', async () => {
    requestId = crypto.randomUUID();
    await reserveInferenceCredits(db, { requestId, userId, amountMicrodollars: 0 });
    const row = await usage(0);
    expect(await insertUsageRecord(row.core, row.metadata)).toMatchObject({
      newMicrodollarsUsed: null,
    });
    const result = await state();
    expect(result.user).toMatchObject({ microdollars_used: 0, inference_microdollars_held: 60 });
    expect(result.reservation).toMatchObject({ status: 'settled', actual_cost_microdollars: 0 });
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
    expect(await insertUsageRecord(row.core, row.metadata)).toMatchObject({
      newMicrodollarsUsed: null,
    });
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
