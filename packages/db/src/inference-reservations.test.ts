import { afterAll, describe, expect, it } from '@jest/globals';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { createDrizzleClient } from './client';
import { computeDatabaseUrl } from './database-url';
import {
  InferenceReservationError,
  lockInferenceReservationForSettlement,
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
  poolConfig: { application_name: 'inference-reservations-test', max: 8 },
});

afterAll(async () => {
  await pool.end();
});

type Fixture = { userId: string; otherUserId: string; organizationId: string };
type Input = Parameters<typeof reserveInferenceCredits>[1];

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
  return { requestId: crypto.randomUUID(), userId: fixture.userId, amountMicrodollars };
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
  await db.transaction(async tx => {
    const settlement = { ...input, actualCostMicrodollars: cost };
    await lockInferenceReservationForSettlement(tx, settlement);
    await tx.insert(microdollar_usage).values({
      id: input.requestId,
      kilo_user_id: input.userId,
      organization_id: input.organizationId,
      cost,
      input_tokens: 1,
      output_tokens: 1,
      cache_write_tokens: 0,
      cache_hit_tokens: 0,
    });
    if (input.organizationId) {
      await tx
        .insert(organization_user_usage)
        .values({
          organization_id: input.organizationId,
          kilo_user_id: input.userId,
          limit_type: 'daily',
          usage_date: sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`,
          microdollar_usage: cost,
        })
        .onConflictDoUpdate({
          target: [
            organization_user_usage.organization_id,
            organization_user_usage.kilo_user_id,
            organization_user_usage.limit_type,
            organization_user_usage.usage_date,
          ],
          set: { microdollar_usage: sql`${organization_user_usage.microdollar_usage} + ${cost}` },
        });
      await tx
        .update(organizations)
        .set({
          microdollars_used: sql`${organizations.microdollars_used} + ${cost}`,
          microdollars_balance: sql`${organizations.microdollars_balance} - ${cost}`,
        })
        .where(eq(organizations.id, input.organizationId));
    } else {
      await tx
        .update(kilocode_users)
        .set({ microdollars_used: sql`${kilocode_users.microdollars_used} + ${cost}` })
        .where(eq(kilocode_users.id, input.userId));
    }
    await settleInferenceCredits(tx, settlement);
  });
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

describe('inference credit reservations', () => {
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

  it('reuses an active request ID concurrently without adding a second hold', async () => {
    await withFixture(async fixture => {
      const input = personal(fixture);
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
      expect((await userState(fixture.userId)).inference_microdollars_held).toBe(60);
      await expect(
        reserveInferenceCredits(db, { ...input, amountMicrodollars: 61 })
      ).rejects.toMatchObject({ reason: 'identity_mismatch' });
      await expect(
        reserveInferenceCredits(db, { ...input, userId: fixture.otherUserId })
      ).rejects.toMatchObject({ reason: 'identity_mismatch' });
      await expect(
        reserveInferenceCredits(db, { ...input, organizationId: fixture.organizationId })
      ).rejects.toMatchObject({ reason: 'identity_mismatch' });
      expect((await userState(fixture.otherUserId)).inference_microdollars_held).toBe(0);
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
        const prepared = db.transaction(async tx => {
          await lockInferenceReservationForSettlement(tx, settlement);
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
          await tx.execute(sql`
            UPDATE ${payer} SET microdollars_used = ${payer.microdollars_used} + 20
            WHERE ${payer.id} = ${payerId}
          `);
          await settleInferenceCredits(tx, settlement);
        });
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
          db.transaction(tx => settleInferenceCredits(tx, { ...input, actualCostMicrodollars: 5 }))
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
          settleInferenceCredits(tx, { ...input, actualCostMicrodollars: 130 })
        );
        await db.transaction(tx => releaseInferenceCredits(tx, input));
        await expect(postUsage(input, 130)).rejects.toThrow();
        await expect(
          db.transaction(tx =>
            settleInferenceCredits(tx, { ...input, actualCostMicrodollars: 131 })
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
        db.transaction(async tx => {
          await settleInferenceCredits(tx, { ...input, actualCostMicrodollars: 20 });
          await tx
            .update(kilocode_users)
            .set({ microdollars_used: 20 })
            .where(eq(kilocode_users.id, fixture.userId));
          throw failure;
        })
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
            settleInferenceCredits(tx, { ...input, actualCostMicrodollars: amount })
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
          settleInferenceCredits(tx, {
            ...input,
            organizationId: fixture.organizationId,
            actualCostMicrodollars: 20,
          })
        )
      ).rejects.toMatchObject({ reason: 'identity_mismatch' });
      await expect(
        db.transaction(tx =>
          settleInferenceCredits(tx, {
            ...input,
            requestId: crypto.randomUUID(),
            actualCostMicrodollars: 20,
          })
        )
      ).rejects.toMatchObject({ reason: 'not_found' });
      expect((await userState(fixture.userId)).inference_microdollars_held).toBe(60);
      expect((await userState(fixture.otherUserId)).inference_microdollars_held).toBe(0);
      expect((await organizationState(fixture.organizationId)).inference_microdollars_held).toBe(0);
    });
  });
});
