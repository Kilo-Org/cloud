import { afterAll, beforeAll, describe, expect, it } from '@jest/globals';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDrizzleClient } from './client';
import { computeDatabaseUrl } from './database-url';
import {
  InferenceReservationError,
  releaseInferenceCredits,
  reserveInferenceCredits,
  settleInferenceCredits,
} from './inference-reservations';
import {
  inference_reservations,
  kilocode_users,
  microdollar_usage,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
} from './schema';

if (process.env.USE_PRODUCTION_DB === 'true') {
  throw new Error('Inference reservation tests require a non-production database');
}

const { db, pool } = createDrizzleClient({
  connectionString: computeDatabaseUrl(),
  poolConfig: { application_name: 'inference-reservations-test', max: 8, pipeline: true },
});

beforeAll(async () => {
  const client = await pool.connect();
  try {
    if (!('pipeline' in client) || client.pipeline !== true) {
      throw new Error('Reservation regressions require native query pipelining');
    }
  } finally {
    client.release();
  }
});

afterAll(async () => {
  await pool.end();
});

type Fixture = { userId: string; otherUserId: string; organizationId: string };
type Input = Parameters<typeof reserveInferenceCredits>[1] & { occurredAt: string };

async function withFixture(work: (fixture: Fixture) => Promise<void>): Promise<void> {
  const userId = `oauth/reservation/${crypto.randomUUID()}`;
  const otherUserId = `oauth/reservation/${crypto.randomUUID()}`;
  await db.insert(kilocode_users).values(
    [userId, otherUserId].map(id => ({
      id,
      google_user_email: `${crypto.randomUUID()}@example.com`,
      google_user_name: 'Reservation test',
      google_user_image_url: '',
      stripe_customer_id: `cus_${crypto.randomUUID()}`,
      total_microdollars_acquired: 100,
    }))
  );
  const [organization] = await db
    .insert(organizations)
    .values({ name: 'Reservation test', total_microdollars_acquired: 100, require_seats: false })
    .returning({ id: organizations.id });
  if (!organization) throw new Error('Reservation organization fixture missing');
  await db.insert(organization_memberships).values([
    { organization_id: organization.id, kilo_user_id: userId, role: 'owner' },
    { organization_id: organization.id, kilo_user_id: otherUserId, role: 'member' },
  ]);
  try {
    await work({ userId, otherUserId, organizationId: organization.id });
  } finally {
    await db
      .delete(inference_reservations)
      .where(inArray(inference_reservations.kilo_user_id, [userId, otherUserId]));
    await db
      .delete(microdollar_usage)
      .where(inArray(microdollar_usage.kilo_user_id, [userId, otherUserId]));
    await db
      .delete(organization_user_usage)
      .where(eq(organization_user_usage.organization_id, organization.id));
    await db
      .delete(organization_user_limits)
      .where(eq(organization_user_limits.organization_id, organization.id));
    await db
      .delete(organization_memberships)
      .where(eq(organization_memberships.organization_id, organization.id));
    await db.delete(organizations).where(eq(organizations.id, organization.id));
    await db.delete(kilocode_users).where(inArray(kilocode_users.id, [userId, otherUserId]));
  }
}

function personal(fixture: Fixture, amountMicrodollars = 60): Input {
  return {
    requestId: crypto.randomUUID(),
    userId: fixture.userId,
    amountMicrodollars,
    occurredAt: new Date().toISOString(),
  };
}

function organization(fixture: Fixture, amountMicrodollars = 60): Input {
  return { ...personal(fixture, amountMicrodollars), organizationId: fixture.organizationId };
}

async function userState(userId: string) {
  const [row] = await db.select().from(kilocode_users).where(eq(kilocode_users.id, userId));
  if (!row) throw new Error('Reservation user missing');
  return row;
}

async function organizationState(organizationId: string) {
  const [row] = await db.select().from(organizations).where(eq(organizations.id, organizationId));
  if (!row) throw new Error('Reservation organization missing');
  return row;
}

async function reservationState(requestId: string) {
  const [row] = await db
    .select()
    .from(inference_reservations)
    .where(eq(inference_reservations.request_id, requestId));
  return row;
}

async function postUsage(input: Input, cost: number): Promise<void> {
  await db.transaction(tx =>
    settleInferenceCredits(tx, { ...input, actualCostMicrodollars: cost }, async debitPayer => {
      await tx.insert(microdollar_usage).values({
        id: input.requestId,
        kilo_user_id: input.userId,
        organization_id: input.organizationId,
        cost,
        created_at: input.occurredAt,
        input_tokens: 1,
        output_tokens: 1,
        cache_write_tokens: 0,
        cache_hit_tokens: 0,
      });
      await debitPayer();
    })
  );
}

async function setAllowance(fixture: Fixture, limit: number, usage = 0): Promise<void> {
  await db.insert(organization_user_limits).values({
    organization_id: fixture.organizationId,
    kilo_user_id: fixture.userId,
    limit_type: 'daily',
    microdollar_limit: limit,
  });
  await db.insert(organization_user_usage).values({
    organization_id: fixture.organizationId,
    kilo_user_id: fixture.userId,
    limit_type: 'daily',
    usage_date: sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`,
    microdollar_usage: usage,
  });
}

async function waitForBlockedReservations(blockingPid: number, expected: number): Promise<void> {
  const deadline = Date.now() + 750;
  do {
    const state = await pool.query<{ count: number }>(
      `
      WITH RECURSIVE blocked AS (
        SELECT pid FROM pg_stat_activity WHERE $1::int = ANY(pg_blocking_pids(pid))
        UNION
        SELECT activity.pid FROM pg_stat_activity activity
        JOIN blocked ON blocked.pid = ANY(pg_blocking_pids(activity.pid))
      )
      SELECT count(*)::int AS count FROM blocked
      JOIN pg_stat_activity USING (pid)
      WHERE datname = current_database() AND query LIKE '%inference_reservations%'
    `,
      [blockingPid]
    );
    if ((state.rows[0]?.count ?? 0) >= expected) return;
  } while (Date.now() < deadline);
  throw new Error('Reservation transactions did not reach the PostgreSQL lock barrier');
}

describe('inference credit reservations', () => {
  it.each(['personal', 'organization'] as const)(
    'admits both %s requests after a payer wait when their combined holds fit',
    async kind => {
      await withFixture(async fixture => {
        const makeInput = kind === 'personal' ? personal : organization;
        const inputs = [makeInput(fixture, 40), makeInput(fixture, 40)];
        const table = kind === 'personal' ? 'kilocode_users' : 'organizations';
        const payerId = kind === 'personal' ? fixture.userId : fixture.organizationId;
        const locker = await pool.connect();
        let pending:
          | Promise<PromiseSettledResult<Awaited<ReturnType<typeof reserveInferenceCredits>>>[]>
          | undefined;
        let open = false;
        try {
          await locker.query('BEGIN');
          open = true;
          const identity = await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
          const pid = identity.rows[0]?.pid;
          if (!pid) throw new Error('Missing blocking backend identity');
          await locker.query(`SELECT id FROM ${table} WHERE id = $1 FOR NO KEY UPDATE`, [payerId]);
          pending = Promise.allSettled(inputs.map(input => reserveInferenceCredits(db, input)));
          await waitForBlockedReservations(pid, 2);
          await locker.query('COMMIT');
          open = false;
          for (const decision of await pending) {
            if (decision.status === 'rejected') throw decision.reason;
            expect(decision.value).toMatchObject({ kind: 'reserved', amountMicrodollars: 40 });
          }
          const payer =
            kind === 'personal'
              ? await userState(fixture.userId)
              : await organizationState(fixture.organizationId);
          expect(payer).toMatchObject({ inference_microdollars_held: 80, microdollars_used: 0 });
          await Promise.all(
            inputs.map(input => db.transaction(tx => releaseInferenceCredits(tx, input)))
          );
          const released =
            kind === 'personal'
              ? await userState(fixture.userId)
              : await organizationState(fixture.organizationId);
          expect(released.inference_microdollars_held).toBe(0);
        } finally {
          if (open) await locker.query('ROLLBACK');
          locker.release();
          await pending;
        }
      });
    }
  );

  it('rolls back a failed pipelined admission before reusing its connection for another payer', async () => {
    const isolated = createDrizzleClient({
      connectionString: computeDatabaseUrl(),
      poolConfig: { max: 1, pipeline: true },
    });
    try {
      await withFixture(async fixture => {
        const bad = { ...personal(fixture), userId: `missing/${crypto.randomUUID()}` };
        await expect(reserveInferenceCredits(isolated.db, bad)).rejects.toMatchObject({
          cause: { code: '23503' },
        });
        expect(await reservationState(bad.requestId)).toBeUndefined();
        const good = personal(fixture, 100);
        expect(await reserveInferenceCredits(isolated.db, good)).toMatchObject({
          kind: 'reserved',
        });
        expect((await userState(fixture.userId)).inference_microdollars_held).toBe(100);
        await isolated.db.transaction(tx => releaseInferenceCredits(tx, good));
        expect((await userState(fixture.userId)).inference_microdollars_held).toBe(0);
      });
    } finally {
      await isolated.pool.end();
    }
  });
  it.each(['personal', 'organization'] as const)(
    'serializes concurrent %s payer admission without spending the same funds twice',
    async kind => {
      await withFixture(async fixture => {
        const makeInput = kind === 'personal' ? personal : organization;
        const results = await Promise.all(
          Array.from({ length: 4 }, () => reserveInferenceCredits(db, makeInput(fixture)))
        );
        expect(results.filter(result => result.kind === 'reserved')).toHaveLength(1);
        expect(results.filter(result => result.kind === 'insufficient')).toHaveLength(3);
        const payer =
          kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId);
        expect(payer.inference_microdollars_held).toBe(60);
        expect(payer.microdollars_used).toBe(0);
        const rows = await db
          .select()
          .from(inference_reservations)
          .where(eq(inference_reservations.kilo_user_id, fixture.userId));
        expect(rows).toHaveLength(1);
      });
    }
  );

  it.each(['personal', 'organization'] as const)(
    'reuses an active %s request ID concurrently without adding a second hold',
    async kind => {
      await withFixture(async fixture => {
        const input = kind === 'personal' ? personal(fixture) : organization(fixture);
        const results = await Promise.all(
          Array.from({ length: 4 }, () => reserveInferenceCredits(db, input))
        );
        expect(results).toEqual(
          Array.from({ length: 4 }, () => ({
            kind: 'reserved',
            requestId: input.requestId,
            amountMicrodollars: 60,
          }))
        );
        const payer =
          kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId);
        expect(payer.inference_microdollars_held).toBe(60);
        await expect(
          reserveInferenceCredits(db, { ...input, amountMicrodollars: 61 })
        ).rejects.toMatchObject({ reason: 'identity_mismatch' });
        await expect(
          reserveInferenceCredits(db, { ...input, userId: fixture.otherUserId })
        ).rejects.toMatchObject({ reason: 'identity_mismatch' });
        await expect(
          reserveInferenceCredits(db, {
            ...input,
            organizationId: kind === 'personal' ? fixture.organizationId : undefined,
          })
        ).rejects.toMatchObject({ reason: 'identity_mismatch' });
        expect((await userState(fixture.otherUserId)).inference_microdollars_held).toBe(0);
      });
    }
  );

  it('never admits an unfunded organization created after the admission snapshot', async () => {
    await withFixture(async fixture => {
      const input = { ...organization(fixture), organizationId: crypto.randomUUID() };
      const locker = await pool.connect();
      let admission: ReturnType<typeof reserveInferenceCredits> | undefined;
      try {
        await locker.query('BEGIN');
        const identity = await locker.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const pid = identity.rows[0]?.pid;
        if (!pid) throw new Error('Missing blocking backend identity');
        await locker.query('SELECT id FROM kilocode_users WHERE id = $1 FOR UPDATE', [
          fixture.userId,
        ]);
        admission = reserveInferenceCredits(db, input);
        await waitForBlockedReservations(pid, 1);
        await db.insert(organizations).values({
          id: input.organizationId,
          name: 'Concurrent reservation payer',
          total_microdollars_acquired: 0,
        });
        await locker.query('COMMIT');
        expect(await admission).toEqual({ kind: 'insufficient' });
        expect(await reservationState(input.requestId)).toBeUndefined();
        expect((await organizationState(input.organizationId)).inference_microdollars_held).toBe(0);
      } finally {
        await locker.query('ROLLBACK');
        locker.release();
        await admission?.catch(() => undefined);
        await db
          .delete(inference_reservations)
          .where(eq(inference_reservations.request_id, input.requestId));
        await db.delete(organizations).where(eq(organizations.id, input.organizationId));
      }
    });
  });

  it('preserves organization payer identity across UUID letter casing on retry and cancellation', async () => {
    await withFixture(async fixture => {
      const input = organization(fixture);
      await reserveInferenceCredits(db, input);
      const upper = { ...input, organizationId: fixture.organizationId.toUpperCase() };
      expect(await reserveInferenceCredits(db, upper)).toMatchObject({ kind: 'reserved' });
      expect((await organizationState(fixture.organizationId)).inference_microdollars_held).toBe(
        60
      );
      await db.transaction(tx => releaseInferenceCredits(tx, upper));
      expect((await organizationState(fixture.organizationId)).inference_microdollars_held).toBe(0);
      expect(await reservationState(input.requestId)).toMatchObject({ status: 'released' });
    });
  });

  it.each(['personal', 'organization'] as const)(
    'locks the %s reservation without blocking payer writes during billing preparation',
    async kind => {
      await withFixture(async fixture => {
        const input = kind === 'personal' ? personal(fixture) : organization(fixture);
        const payer = kind === 'personal' ? kilocode_users : organizations;
        const payerId = input.organizationId ?? input.userId;
        const settlement = { ...input, actualCostMicrodollars: 20 };
        await reserveInferenceCredits(db, input);
        const ready = Promise.withResolvers<void>();
        const proceed = Promise.withResolvers<void>();
        const prepared = db.transaction(tx =>
          settleInferenceCredits(tx, settlement, async debitPayer => {
            ready.resolve();
            await proceed.promise;
            await tx.insert(microdollar_usage).values({
              id: input.requestId,
              kilo_user_id: input.userId,
              organization_id: input.organizationId,
              cost: 20,
              input_tokens: 1,
              output_tokens: 1,
              cache_write_tokens: 0,
              cache_hit_tokens: 0,
            });
            await debitPayer();
          })
        );
        try {
          await Promise.race([ready.promise, prepared]);
          const probe = await pool.connect();
          try {
            await expect(
              probe.query(
                'SELECT request_id FROM inference_reservations WHERE request_id=$1 FOR UPDATE NOWAIT',
                [input.requestId]
              )
            ).rejects.toMatchObject({ code: '55P03' });
          } finally {
            probe.release();
          }
          await db.transaction(async tx => {
            await tx.execute(sql`SELECT set_config('lock_timeout', '250ms', true)`);
            await tx.execute(sql`
              UPDATE ${payer} SET microdollars_used = ${payer.microdollars_used} + 25
              WHERE ${payer.id} = ${payerId}
            `);
          });
          const state =
            kind === 'personal' ? await userState(input.userId) : await organizationState(payerId);
          expect(state).toMatchObject({ inference_microdollars_held: 60, microdollars_used: 25 });
        } finally {
          proceed.resolve();
          await prepared;
        }
        const result =
          kind === 'personal' ? await userState(input.userId) : await organizationState(payerId);
        expect(result).toMatchObject({ inference_microdollars_held: 0, microdollars_used: 45 });
        expect(await reservationState(input.requestId)).toMatchObject({
          status: 'settled',
          actual_cost_microdollars: 20,
        });
      });
    }
  );

  it.each(['personal', 'organization'] as const)(
    'releases a %s hold exactly once and never reauthorizes its terminal request',
    async kind => {
      await withFixture(async fixture => {
        const input = kind === 'personal' ? personal(fixture) : organization(fixture);
        await reserveInferenceCredits(db, input);
        await Promise.all(
          Array.from({ length: 4 }, () => db.transaction(tx => releaseInferenceCredits(tx, input)))
        );
        const payer =
          kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId);
        expect(payer.inference_microdollars_held).toBe(0);
        expect((await reservationState(input.requestId))?.status).toBe('released');
        await expect(reserveInferenceCredits(db, input)).rejects.toMatchObject({
          reason: 'terminal',
        });
        await expect(
          db.transaction(tx =>
            settleInferenceCredits(tx, { ...input, actualCostMicrodollars: 5 }, debitPayer =>
              debitPayer()
            )
          )
        ).rejects.toMatchObject({ reason: 'terminal' });
        expect(
          await reserveInferenceCredits(db, {
            ...input,
            requestId: crypto.randomUUID(),
            amountMicrodollars: 100,
          })
        ).toMatchObject({ kind: 'reserved' });
      });
    }
  );

  it.each(['personal', 'organization'] as const)(
    'persists a %s no-dispatch cancellation before a late admission arrives',
    async kind => {
      await withFixture(async fixture => {
        const input = kind === 'personal' ? personal(fixture) : organization(fixture);
        await db.transaction(tx => releaseInferenceCredits(tx, input));
        await db.transaction(tx => releaseInferenceCredits(tx, input));
        expect(await reservationState(input.requestId)).toMatchObject({
          status: 'released',
          amount_microdollars: 0,
        });
        await expect(reserveInferenceCredits(db, input)).rejects.toMatchObject({
          reason: 'terminal',
        });
        const payer =
          kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId);
        expect(payer.inference_microdollars_held).toBe(0);
      });
    }
  );

  it.each(['personal', 'organization'] as const)(
    'serializes concurrent %s cancellation and admission without resurrecting the request',
    async kind => {
      await withFixture(async fixture => {
        const input = kind === 'personal' ? personal(fixture) : organization(fixture);
        const [admission, cancellation] = await Promise.allSettled([
          reserveInferenceCredits(db, input),
          db.transaction(tx => releaseInferenceCredits(tx, input)),
        ]);
        expect(cancellation.status).toBe('fulfilled');
        if (admission.status === 'rejected')
          expect(admission.reason).toMatchObject({ reason: 'terminal' });
        expect((await reservationState(input.requestId))?.status).toBe('released');
        const payer =
          kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId);
        expect(payer.inference_microdollars_held).toBe(0);
        await expect(reserveInferenceCredits(db, input)).rejects.toMatchObject({
          reason: 'terminal',
        });
      });
    }
  );

  it.each(['personal', 'organization'] as const)(
    'posts %s over-ceiling incurred usage and preserves the resulting debt',
    async kind => {
      await withFixture(async fixture => {
        const input = kind === 'personal' ? personal(fixture) : organization(fixture);
        await reserveInferenceCredits(db, input);
        await postUsage(input, 130);
        const payer =
          kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId);
        expect(payer.inference_microdollars_held).toBe(0);
        expect(payer.microdollars_used).toBe(130);
        expect(payer.total_microdollars_acquired - payer.microdollars_used).toBe(-30);
        expect(await reservationState(input.requestId)).toMatchObject({
          status: 'settled',
          actual_cost_microdollars: 130,
        });
        await db.transaction(tx =>
          settleInferenceCredits(
            tx,
            { ...input, actualCostMicrodollars: 130 },
            async () => undefined
          )
        );
        await db.transaction(tx => releaseInferenceCredits(tx, input));
        await expect(postUsage(input, 130)).rejects.toThrow();
        await expect(
          db.transaction(tx =>
            settleInferenceCredits(tx, { ...input, actualCostMicrodollars: 131 }, debitPayer =>
              debitPayer()
            )
          )
        ).rejects.toMatchObject({ reason: 'identity_mismatch' });
        await expect(reserveInferenceCredits(db, input)).rejects.toMatchObject({
          reason: 'terminal',
        });
        expect(
          await reserveInferenceCredits(db, {
            ...input,
            requestId: crypto.randomUUID(),
            amountMicrodollars: 1,
          })
        ).toEqual({ kind: 'insufficient' });
        const [usage] = await db
          .select()
          .from(microdollar_usage)
          .where(eq(microdollar_usage.id, input.requestId));
        expect(usage?.cost).toBe(130);
        expect(
          (kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId)
          ).microdollars_used
        ).toBe(130);
      });
    }
  );

  it.each(['personal', 'organization'] as const)(
    'settles concurrent %s usage retries exactly once with the caller usage primary key',
    async kind => {
      await withFixture(async fixture => {
        const input = kind === 'personal' ? personal(fixture) : organization(fixture);
        await reserveInferenceCredits(db, input);
        const outcomes = await Promise.allSettled([postUsage(input, 30), postUsage(input, 30)]);
        expect(outcomes.filter(outcome => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter(outcome => outcome.status === 'rejected')).toHaveLength(1);
        const payer =
          kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId);
        expect(payer.inference_microdollars_held).toBe(0);
        expect(payer.microdollars_used).toBe(30);
        expect(await reservationState(input.requestId)).toMatchObject({
          status: 'settled',
          actual_cost_microdollars: 30,
        });
      });
    }
  );

  it('rolls back settlement, hold release and usage together when actual accounting fails', async () => {
    await withFixture(async fixture => {
      const input = personal(fixture);
      await reserveInferenceCredits(db, input);
      const failure = new Error('accounting rejected');
      await expect(
        db.transaction(tx =>
          settleInferenceCredits(tx, { ...input, actualCostMicrodollars: 20 }, async debitPayer => {
            await debitPayer();
            throw failure;
          })
        )
      ).rejects.toBe(failure);
      expect(await reservationState(input.requestId)).toMatchObject({
        status: 'reserved',
        actual_cost_microdollars: null,
      });
      expect(await userState(fixture.userId)).toMatchObject({
        inference_microdollars_held: 60,
        microdollars_used: 0,
      });
      await postUsage(input, 20);
      expect(await reserveInferenceCredits(db, personal(fixture, 80))).toMatchObject({
        kind: 'reserved',
      });
    });
  });

  it.each(['personal', 'organization'] as const)(
    'rolls back a %s settlement callback that omits or repeats its payer debit',
    async kind => {
      await withFixture(async fixture => {
        const input = kind === 'personal' ? personal(fixture) : organization(fixture);
        const settlement = { ...input, actualCostMicrodollars: 20 };
        await reserveInferenceCredits(db, input);
        await expect(
          db.transaction(tx => settleInferenceCredits(tx, settlement, async () => undefined))
        ).rejects.toMatchObject({ reason: 'counter_integrity' });
        await expect(
          db.transaction(tx =>
            settleInferenceCredits(tx, settlement, async debitPayer => {
              await debitPayer();
              await debitPayer();
            })
          )
        ).rejects.toMatchObject({ reason: 'terminal' });
        expect(await reservationState(input.requestId)).toMatchObject({
          status: 'reserved',
          actual_cost_microdollars: null,
        });
        const payer =
          kind === 'personal'
            ? await userState(fixture.userId)
            : await organizationState(fixture.organizationId);
        expect(payer).toMatchObject({ inference_microdollars_held: 60, microdollars_used: 0 });
      });
    }
  );

  it('serializes member allowance admission against committed usage and all active holds', async () => {
    await withFixture(async fixture => {
      await setAllowance(fixture, 70, 10);
      const inputs = [organization(fixture, 40), organization(fixture, 40)];
      const results = await Promise.all(inputs.map(input => reserveInferenceCredits(db, input)));
      expect(results.filter(result => result.kind === 'reserved')).toHaveLength(1);
      expect((await organizationState(fixture.organizationId)).inference_microdollars_held).toBe(
        40
      );
      const admitted = inputs[results.findIndex(result => result.kind === 'reserved')];
      if (!admitted) throw new Error('Expected one admitted reservation');
      await db
        .update(inference_reservations)
        .set({ created_at: '2000-01-01T00:00:00.000Z' })
        .where(eq(inference_reservations.request_id, admitted.requestId));
      expect(await reserveInferenceCredits(db, organization(fixture, 21))).toEqual({
        kind: 'insufficient',
      });
      await postUsage(admitted, 20);
      expect(await reserveInferenceCredits(db, organization(fixture, 40))).toMatchObject({
        kind: 'reserved',
      });
      expect(await reserveInferenceCredits(db, organization(fixture, 1))).toEqual({
        kind: 'insufficient',
      });
    });
  });

  it('uses one organization balance across different members while keeping personal credit separate', async () => {
    await withFixture(async fixture => {
      const first = organization(fixture);
      const second = { ...organization(fixture), userId: fixture.otherUserId };
      const results = await Promise.all([
        reserveInferenceCredits(db, first),
        reserveInferenceCredits(db, second),
      ]);
      expect(results.filter(result => result.kind === 'reserved')).toHaveLength(1);
      expect(await reserveInferenceCredits(db, personal(fixture, 100))).toMatchObject({
        kind: 'reserved',
      });
      expect((await organizationState(fixture.organizationId)).inference_microdollars_held).toBe(
        60
      );
      expect((await userState(fixture.userId)).inference_microdollars_held).toBe(100);
    });
  });

  it('ignores member allowance for seat-based organizations but still enforces organization funds', async () => {
    await withFixture(async fixture => {
      await setAllowance(fixture, 0);
      await db
        .update(organizations)
        .set({ require_seats: true })
        .where(eq(organizations.id, fixture.organizationId));
      expect(await reserveInferenceCredits(db, organization(fixture, 100))).toMatchObject({
        kind: 'reserved',
      });
      expect(await reserveInferenceCredits(db, organization(fixture, 1))).toEqual({
        kind: 'insufficient',
      });
    });
  });

  it('rejects nonmembers, billing managers and deleted organizations without retaining holds', async () => {
    await withFixture(async fixture => {
      await db
        .delete(organization_memberships)
        .where(
          and(
            eq(organization_memberships.organization_id, fixture.organizationId),
            eq(organization_memberships.kilo_user_id, fixture.userId)
          )
        );
      expect(await reserveInferenceCredits(db, organization(fixture))).toEqual({
        kind: 'insufficient',
      });
      await db.insert(organization_memberships).values({
        organization_id: fixture.organizationId,
        kilo_user_id: fixture.userId,
        role: 'billing_manager',
      });
      expect(await reserveInferenceCredits(db, organization(fixture))).toEqual({
        kind: 'insufficient',
      });
      await db
        .update(organizations)
        .set({ deleted_at: new Date().toISOString() })
        .where(eq(organizations.id, fixture.organizationId));
      expect(
        await reserveInferenceCredits(db, { ...organization(fixture), userId: fixture.otherUserId })
      ).toEqual({ kind: 'insufficient' });
      expect((await organizationState(fixture.organizationId)).inference_microdollars_held).toBe(0);
      expect(
        await db
          .select()
          .from(inference_reservations)
          .where(eq(inference_reservations.organization_id, fixture.organizationId))
      ).toEqual([]);
    });
  });

  it('retains an old uncertain reservation and does not refund it by age', async () => {
    await withFixture(async fixture => {
      const input = personal(fixture);
      await reserveInferenceCredits(db, input);
      await db
        .update(inference_reservations)
        .set({ created_at: '2000-01-01T00:00:00.000Z' })
        .where(eq(inference_reservations.request_id, input.requestId));
      expect(await reserveInferenceCredits(db, input)).toMatchObject({ kind: 'reserved' });
      expect(await reserveInferenceCredits(db, personal(fixture, 41))).toEqual({
        kind: 'insufficient',
      });
      expect((await userState(fixture.userId)).inference_microdollars_held).toBe(60);
    });
  });

  it('prevents payer deletion from erasing live or terminal reservation identity', async () => {
    await withFixture(async fixture => {
      const input = organization(fixture);
      await reserveInferenceCredits(db, input);
      await expect(
        db.delete(organizations).where(eq(organizations.id, fixture.organizationId))
      ).rejects.toThrow();
      await expect(
        db.delete(kilocode_users).where(eq(kilocode_users.id, fixture.userId))
      ).rejects.toThrow();
      await db.transaction(tx => releaseInferenceCredits(tx, input));
      await expect(
        db.delete(organizations).where(eq(organizations.id, fixture.organizationId))
      ).rejects.toThrow();
      expect((await reservationState(input.requestId))?.status).toBe('released');
    });
  });

  it('fails atomically rather than underflowing a corrupted payer counter', async () => {
    await withFixture(async fixture => {
      const input = personal(fixture);
      await reserveInferenceCredits(db, input);
      await db
        .update(kilocode_users)
        .set({ inference_microdollars_held: 59 })
        .where(eq(kilocode_users.id, fixture.userId));
      await expect(db.transaction(tx => releaseInferenceCredits(tx, input))).rejects.toMatchObject({
        reason: 'counter_integrity',
      });
      await expect(postUsage(input, 80)).rejects.toBeInstanceOf(InferenceReservationError);
      expect(await reservationState(input.requestId)).toMatchObject({
        status: 'reserved',
        actual_cost_microdollars: null,
      });
      expect((await userState(fixture.userId)).inference_microdollars_held).toBe(59);
      expect(
        await db.select().from(microdollar_usage).where(eq(microdollar_usage.id, input.requestId))
      ).toEqual([]);
      await db
        .update(kilocode_users)
        .set({ inference_microdollars_held: -1 })
        .where(eq(kilocode_users.id, fixture.userId));
      await expect(reserveInferenceCredits(db, personal(fixture, 1))).resolves.toEqual({
        kind: 'insufficient',
      });
    });
  });

  it('supports the safe integer ceiling without counter overflow', async () => {
    await withFixture(async fixture => {
      await db
        .update(kilocode_users)
        .set({ total_microdollars_acquired: Number.MAX_SAFE_INTEGER })
        .where(eq(kilocode_users.id, fixture.userId));
      const input = personal(fixture, Number.MAX_SAFE_INTEGER);
      expect(await reserveInferenceCredits(db, input)).toMatchObject({
        kind: 'reserved',
        amountMicrodollars: Number.MAX_SAFE_INTEGER,
      });
      expect(await reserveInferenceCredits(db, personal(fixture, 1))).toEqual({
        kind: 'insufficient',
      });
      await db.transaction(tx => releaseInferenceCredits(tx, input));
      expect((await userState(fixture.userId)).inference_microdollars_held).toBe(0);
    });
  });

  it.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1])(
    'rejects unsafe money %s before changing balances',
    async amount => {
      await withFixture(async fixture => {
        const input = personal(fixture, amount);
        await expect(reserveInferenceCredits(db, input)).rejects.toBeInstanceOf(RangeError);
        await expect(
          db.transaction(tx =>
            settleInferenceCredits(tx, { ...input, actualCostMicrodollars: amount }, debitPayer =>
              debitPayer()
            )
          )
        ).rejects.toBeInstanceOf(RangeError);
        expect((await userState(fixture.userId)).inference_microdollars_held).toBe(0);
        expect(await reservationState(input.requestId)).toBeUndefined();
      });
    }
  );

  it('rejects foreign settlement and release identities without touching either payer', async () => {
    await withFixture(async fixture => {
      const input = personal(fixture);
      await reserveInferenceCredits(db, input);
      await expect(
        db.transaction(tx => releaseInferenceCredits(tx, { ...input, userId: fixture.otherUserId }))
      ).rejects.toMatchObject({ reason: 'identity_mismatch' });
      await expect(
        db.transaction(tx =>
          settleInferenceCredits(
            tx,
            { ...input, organizationId: fixture.organizationId, actualCostMicrodollars: 20 },
            debitPayer => debitPayer()
          )
        )
      ).rejects.toMatchObject({ reason: 'identity_mismatch' });
      await expect(
        db.transaction(tx =>
          settleInferenceCredits(
            tx,
            { ...input, requestId: crypto.randomUUID(), actualCostMicrodollars: 20 },
            debitPayer => debitPayer()
          )
        )
      ).rejects.toMatchObject({ reason: 'not_found' });
      expect((await userState(fixture.userId)).inference_microdollars_held).toBe(60);
      expect((await userState(fixture.otherUserId)).inference_microdollars_held).toBe(0);
      expect((await organizationState(fixture.organizationId)).inference_microdollars_held).toBe(0);
    });
  });
});
