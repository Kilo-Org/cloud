import { and, eq, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgDatabase, NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type * as schema from './schema';
import {
  inference_reservations,
  kilocode_users,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
} from './schema';

export type InferenceReservationTransaction = PgTransaction<
  NodePgQueryResultHKT,
  typeof schema,
  ExtractTablesWithRelations<typeof schema>
>;

type ReservationIdentity = {
  requestId: string;
  userId: string;
  organizationId?: string;
};

type ReserveInput = ReservationIdentity & { amountMicrodollars: number };
type SettleInput = ReservationIdentity & { actualCostMicrodollars: number };
type Reservation = typeof inference_reservations.$inferSelect;

export type ReserveInferenceCreditsResult =
  | { kind: 'reserved'; requestId: string; amountMicrodollars: number }
  | { kind: 'insufficient' };

export class InferenceReservationError extends Error {
  constructor(
    public readonly reason: 'identity_mismatch' | 'terminal' | 'not_found' | 'counter_integrity'
  ) {
    super(`Inference reservation ${reason}`);
    this.name = 'InferenceReservationError';
  }
}

const insufficientCredits = new Error('Insufficient inference credits');

function validateIdentity(input: ReservationIdentity): void {
  if (
    typeof input.requestId !== 'string' ||
    input.requestId.length === 0 ||
    typeof input.userId !== 'string' ||
    input.userId.length === 0 ||
    (input.organizationId !== undefined && typeof input.organizationId !== 'string')
  ) {
    throw new TypeError('Inference reservation requires text request and user identities');
  }
}

function validateMoney(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount < 0) {
    throw new RangeError('Inference reservation money must be a non-negative safe integer');
  }
}

function assertIdentity(row: Reservation, input: ReservationIdentity): void {
  if (
    row.kilo_user_id !== input.userId ||
    row.organization_id !== (input.organizationId?.toLowerCase() ?? null)
  ) {
    throw new InferenceReservationError('identity_mismatch');
  }
}

async function lockReservation(
  tx: InferenceReservationTransaction,
  input: ReservationIdentity
): Promise<Reservation> {
  const [row] = await tx
    .select()
    .from(inference_reservations)
    .where(eq(inference_reservations.request_id, input.requestId))
    .for('update');
  if (!row) throw new InferenceReservationError('not_found');
  assertIdentity(row, input);
  return row;
}

export async function reserveInferenceCredits(
  db: NodePgDatabase<typeof schema>,
  input: ReserveInput
): Promise<ReserveInferenceCreditsResult> {
  validateIdentity(input);
  validateMoney(input.amountMicrodollars);
  try {
    return await db.transaction<ReserveInferenceCreditsResult>(
      async tx => {
        await tx.execute(sql`
          SELECT
            set_config('lock_timeout', '1s', true),
            set_config('statement_timeout', '2s', true),
            set_config('idle_in_transaction_session_timeout', '5s', true)
        `);
        const [inserted] = await tx
          .insert(inference_reservations)
          .values({
            request_id: input.requestId,
            kilo_user_id: input.userId,
            organization_id: input.organizationId,
            amount_microdollars: input.amountMicrodollars,
          })
          .onConflictDoNothing({ target: inference_reservations.request_id })
          .returning({ requestId: inference_reservations.request_id });

        if (!inserted) {
          const existing = await lockReservation(tx, input);
          if (existing.status !== 'reserved') throw new InferenceReservationError('terminal');
          if (existing.amount_microdollars !== input.amountMicrodollars) {
            throw new InferenceReservationError('identity_mismatch');
          }
          return {
            kind: 'reserved',
            requestId: input.requestId,
            amountMicrodollars: existing.amount_microdollars,
          };
        }

        if (input.organizationId !== undefined) {
          // The next statement needs a fresh snapshot after waiting for the payer lock.
          const [payer] = await tx
            .select({ id: organizations.id })
            .from(organizations)
            .where(eq(organizations.id, input.organizationId))
            .for('no key update');
          if (!payer) throw insufficientCredits;

          const [held] = await tx
            .update(organizations)
            .set({
              inference_microdollars_held: sql`${organizations.inference_microdollars_held} + ${input.amountMicrodollars}`,
            })
            .where(
              and(
                eq(organizations.id, input.organizationId),
                sql`${organizations.deleted_at} IS NULL`,
                sql`${organizations.total_microdollars_acquired} - ${organizations.microdollars_used} - ${organizations.inference_microdollars_held} >= ${input.amountMicrodollars}`,
                sql`${organizations.inference_microdollars_held} >= 0`,
                sql`${organizations.inference_microdollars_held} <= ${Number.MAX_SAFE_INTEGER - input.amountMicrodollars}`,
                sql`EXISTS (
                  SELECT 1 FROM ${organization_memberships}
                  WHERE ${organization_memberships.organization_id} = ${input.organizationId}
                    AND ${organization_memberships.kilo_user_id} = ${input.userId}
                    AND ${organization_memberships.role} <> 'billing_manager'
                )`,
                sql`(${organizations.require_seats} OR NOT EXISTS (
                  SELECT 1
                  FROM ${organization_user_limits}
                  LEFT JOIN ${organization_user_usage}
                    ON ${organization_user_usage.organization_id} = ${organization_user_limits.organization_id}
                    AND ${organization_user_usage.kilo_user_id} = ${organization_user_limits.kilo_user_id}
                    AND ${organization_user_usage.limit_type} = 'daily'
                    AND ${organization_user_usage.usage_date} = (CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date
                  WHERE ${organization_user_limits.organization_id} = ${input.organizationId}
                    AND ${organization_user_limits.kilo_user_id} = ${input.userId}
                    AND ${organization_user_limits.limit_type} = 'daily'
                    AND ${organization_user_limits.microdollar_limit} < COALESCE(${organization_user_usage.microdollar_usage}, 0) + (
                      SELECT COALESCE(SUM(${inference_reservations.amount_microdollars}), 0)
                      FROM ${inference_reservations}
                      WHERE ${inference_reservations.organization_id} = ${input.organizationId}
                        AND ${inference_reservations.kilo_user_id} = ${input.userId}
                        AND ${inference_reservations.status} = 'reserved'
                    )
                ))`
              )
            )
            .returning({ id: organizations.id });
          if (!held) throw insufficientCredits;
        } else {
          const [held] = await tx
            .update(kilocode_users)
            .set({
              inference_microdollars_held: sql`${kilocode_users.inference_microdollars_held} + ${input.amountMicrodollars}`,
            })
            .where(
              and(
                eq(kilocode_users.id, input.userId),
                sql`${kilocode_users.total_microdollars_acquired} - ${kilocode_users.microdollars_used} - ${kilocode_users.inference_microdollars_held} >= ${input.amountMicrodollars}`,
                sql`${kilocode_users.inference_microdollars_held} >= 0`,
                sql`${kilocode_users.inference_microdollars_held} <= ${Number.MAX_SAFE_INTEGER - input.amountMicrodollars}`
              )
            )
            .returning({ id: kilocode_users.id });
          if (!held) throw insufficientCredits;
        }

        return {
          kind: 'reserved',
          requestId: input.requestId,
          amountMicrodollars: input.amountMicrodollars,
        };
      },
      { isolationLevel: 'read committed', accessMode: 'read write' }
    );
  } catch (error) {
    if (error === insufficientCredits) return { kind: 'insufficient' };
    throw error;
  }
}

async function removeHold(tx: InferenceReservationTransaction, row: Reservation): Promise<void> {
  const [payer] = row.organization_id
    ? await tx
        .update(organizations)
        .set({
          inference_microdollars_held: sql`${organizations.inference_microdollars_held} - ${row.amount_microdollars}`,
        })
        .where(
          and(
            eq(organizations.id, row.organization_id),
            sql`${organizations.inference_microdollars_held} >= ${row.amount_microdollars}`
          )
        )
        .returning({ id: organizations.id })
    : await tx
        .update(kilocode_users)
        .set({
          inference_microdollars_held: sql`${kilocode_users.inference_microdollars_held} - ${row.amount_microdollars}`,
        })
        .where(
          and(
            eq(kilocode_users.id, row.kilo_user_id),
            sql`${kilocode_users.inference_microdollars_held} >= ${row.amount_microdollars}`
          )
        )
        .returning({ id: kilocode_users.id });
  if (!payer) throw new InferenceReservationError('counter_integrity');
}

export async function releaseInferenceCredits(
  tx: InferenceReservationTransaction,
  input: ReservationIdentity
): Promise<void> {
  validateIdentity(input);
  const [cancelled] = await tx
    .insert(inference_reservations)
    .values({
      request_id: input.requestId,
      kilo_user_id: input.userId,
      organization_id: input.organizationId,
      amount_microdollars: 0,
      status: 'released',
      finalized_at: sql`now()`,
    })
    .onConflictDoNothing({ target: inference_reservations.request_id })
    .returning({ requestId: inference_reservations.request_id });
  if (cancelled) return;
  const row = await lockReservation(tx, input);
  if (row.status !== 'reserved') return;
  await removeHold(tx, row);
  await tx
    .update(inference_reservations)
    .set({ status: 'released', finalized_at: sql`now()` })
    .where(eq(inference_reservations.request_id, input.requestId));
}

function assertSettlement(row: Reservation, input: SettleInput): void {
  if (row.status === 'released') throw new InferenceReservationError('terminal');
  if (row.status === 'settled' && row.actual_cost_microdollars !== input.actualCostMicrodollars) {
    throw new InferenceReservationError('identity_mismatch');
  }
}

/** Lock the reservation before billing, without locking the payer during metadata preparation. */
export async function lockInferenceReservationForSettlement(
  tx: InferenceReservationTransaction,
  input: SettleInput
): Promise<void> {
  validateIdentity(input);
  validateMoney(input.actualCostMicrodollars);
  assertSettlement(await lockReservation(tx, input), input);
}

export async function settleInferenceCredits(
  tx: InferenceReservationTransaction,
  input: SettleInput
): Promise<void> {
  validateIdentity(input);
  validateMoney(input.actualCostMicrodollars);
  const row = await lockReservation(tx, input);
  assertSettlement(row, input);
  if (row.status === 'settled') return;
  await removeHold(tx, row);
  await tx
    .update(inference_reservations)
    .set({
      status: 'settled',
      actual_cost_microdollars: input.actualCostMicrodollars,
      finalized_at: sql`now()`,
    })
    .where(eq(inference_reservations.request_id, input.requestId));
}
