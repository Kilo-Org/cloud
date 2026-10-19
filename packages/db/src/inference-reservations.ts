import { and, eq, sql } from 'drizzle-orm';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction, PgTransactionConfig } from 'drizzle-orm/pg-core';
import type * as schema from './schema';
import {
  inference_reservations,
  kilocode_users,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
} from './schema';

export type InferenceReservationTransaction = Pick<
  PgTransaction<NodePgQueryResultHKT, typeof schema, ExtractTablesWithRelations<typeof schema>>,
  '$with' | 'with' | 'select' | 'insert' | 'update' | 'delete' | 'execute' | 'rollback'
>;

type ReservationIdentity = {
  requestId: string;
  userId: string;
  organizationId?: string;
};

type ReserveInput = ReservationIdentity & { amountMicrodollars: number };
type SettleInput = ReservationIdentity & { actualCostMicrodollars: number; occurredAt: string };
type Reservation = typeof inference_reservations.$inferSelect;

export type InferenceSettlementPayer =
  | {
      kind: 'personal';
      newMicrodollarsUsed: number;
      kiloPassThreshold: number | null;
    }
  | {
      kind: 'organization';
      total_microdollars_acquired: number;
      previous_microdollars_used: number;
      new_microdollars_used: number;
      settings: (typeof organizations.$inferSelect)['settings'];
    };

type OrganizationCreditUsageInput = {
  userId: string;
  organizationId: string;
  amountMicrodollars: number;
  occurredAt: string;
};

async function updateOrganizationCreditUsage(
  tx: InferenceReservationTransaction,
  input: OrganizationCreditUsageInput,
  heldMicrodollars: number
) {
  const memberUsage = tx.$with('member_usage', {}).as(sql`
    INSERT INTO ${organization_user_usage} (
      organization_id, kilo_user_id, usage_date, limit_type,
      microdollar_usage, created_at, updated_at
    )
    SELECT ${input.organizationId}, ${input.userId},
      (${input.occurredAt}::timestamptz AT TIME ZONE 'UTC')::date,
      'daily', ${input.amountMicrodollars}, NOW(), NOW()
    WHERE ${input.amountMicrodollars} <> 0
      AND EXISTS (
        SELECT 1 FROM ${organization_memberships}
        WHERE ${organization_memberships.organization_id} = ${input.organizationId}
          AND ${organization_memberships.kilo_user_id} = ${input.userId}
      )
      AND EXISTS (
        SELECT 1 FROM ${organizations} WHERE ${organizations.id} = ${input.organizationId}
      )
    ON CONFLICT (organization_id, kilo_user_id, limit_type, usage_date)
    DO UPDATE SET
      microdollar_usage = ${organization_user_usage.microdollar_usage} + ${input.amountMicrodollars},
      updated_at = NOW()
    RETURNING organization_id
  `);
  const [payer] = await tx
    .with(memberUsage)
    .update(organizations)
    .set({
      microdollars_used: sql`${organizations.microdollars_used} + ${input.amountMicrodollars}`,
      microdollars_balance: sql`${organizations.microdollars_balance} - ${input.amountMicrodollars}`,
      inference_microdollars_held:
        heldMicrodollars > 0
          ? sql`${organizations.inference_microdollars_held} - ${heldMicrodollars}`
          : undefined,
    })
    .where(
      and(
        eq(organizations.id, input.organizationId),
        heldMicrodollars > 0
          ? sql`${organizations.inference_microdollars_held} >= ${heldMicrodollars}`
          : undefined,
        sql`${organizations.id} = COALESCE((SELECT organization_id FROM ${memberUsage}), ${input.organizationId}::uuid)`
      )
    )
    .returning({
      kind: sql<'organization'>`'organization'`,
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      previous_microdollars_used:
        sql<number>`${organizations.microdollars_used} - ${input.amountMicrodollars}`.mapWith(
          Number
        ),
      new_microdollars_used: organizations.microdollars_used,
      settings: organizations.settings,
    });
  return payer;
}

export function mutateOrganizationCreditUsage(
  tx: InferenceReservationTransaction,
  input: OrganizationCreditUsageInput
) {
  return updateOrganizationCreditUsage(tx, input, 0);
}

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
  db: {
    transaction<T>(
      callback: (tx: InferenceReservationTransaction) => Promise<T>,
      config?: PgTransactionConfig
    ): Promise<T>;
  },
  input: ReserveInput
): Promise<ReserveInferenceCreditsResult> {
  validateIdentity(input);
  validateMoney(input.amountMicrodollars);
  try {
    return await db.transaction<ReserveInferenceCreditsResult>(
      async tx => {
        const timeoutSetup = tx.execute(sql`
          SELECT
            set_config('lock_timeout', '1s', true),
            set_config('statement_timeout', '2s', true),
            set_config('idle_in_transaction_session_timeout', '5s', true)
        `);
        const insertion = sql`
          INSERT INTO ${inference_reservations}
            (request_id, kilo_user_id, organization_id, amount_microdollars)
          VALUES (${input.requestId}, ${input.userId}, ${input.organizationId ?? null}, ${input.amountMicrodollars})
          ON CONFLICT (request_id) DO NOTHING
          RETURNING request_id
        `;
        const pendingAdmission =
          input.organizationId !== undefined
            ? tx.execute<{ inserted: boolean; held: boolean }>(sql`
              WITH inserted AS (${insertion}), locked AS MATERIALIZED (
                SELECT ${organizations.id}
                FROM ${organizations} CROSS JOIN inserted
                WHERE ${organizations.id} = ${input.organizationId}
                FOR NO KEY UPDATE OF ${organizations}
              )
              SELECT EXISTS (SELECT 1 FROM inserted) AS inserted,
                EXISTS (SELECT 1 FROM locked) AS held
            `)
            : tx.execute<{ inserted: boolean; held: boolean }>(sql`
              WITH inserted AS (${insertion}), held AS (
                UPDATE ${kilocode_users}
                SET inference_microdollars_held = ${kilocode_users.inference_microdollars_held} + ${input.amountMicrodollars}
                WHERE ${kilocode_users.id} = ${input.userId}
                  AND EXISTS (SELECT 1 FROM inserted)
                  AND ${kilocode_users.total_microdollars_acquired} - ${kilocode_users.microdollars_used} - ${kilocode_users.inference_microdollars_held} >= ${input.amountMicrodollars}
                  AND ${kilocode_users.inference_microdollars_held} >= 0
                  AND ${kilocode_users.inference_microdollars_held} <= ${Number.MAX_SAFE_INTEGER - input.amountMicrodollars}
                RETURNING id
              )
              SELECT EXISTS (SELECT 1 FROM inserted) AS inserted,
                EXISTS (SELECT 1 FROM held) AS held
            `);
        const [timeoutResult, admissionResult] = await Promise.allSettled([
          timeoutSetup,
          pendingAdmission,
        ]);
        if (timeoutResult.status === 'rejected') throw timeoutResult.reason;
        if (admissionResult.status === 'rejected') throw admissionResult.reason;
        const attempt = admissionResult.value;
        const inserted = attempt.rows[0]?.inserted;
        if (inserted && !attempt.rows[0]?.held) {
          throw insufficientCredits;
        }

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

function assertSettlement(row: Reservation, actualCostMicrodollars: number): void {
  if (row.status === 'released') throw new InferenceReservationError('terminal');
  if (row.status === 'settled' && row.actual_cost_microdollars !== actualCostMicrodollars) {
    throw new InferenceReservationError('identity_mismatch');
  }
}

/** The callback must persist its idempotent usage source before calling debitPayer. */
export async function settleInferenceCredits<T>(
  tx: InferenceReservationTransaction,
  input: SettleInput,
  writeUsage: (debitPayer: () => Promise<InferenceSettlementPayer>) => Promise<T>
): Promise<T> {
  validateIdentity(input);
  const { actualCostMicrodollars } = input;
  validateMoney(actualCostMicrodollars);
  const [finalized] = await tx
    .update(inference_reservations)
    .set({
      status: 'settled',
      actual_cost_microdollars: actualCostMicrodollars,
      finalized_at: sql`now()`,
    })
    .where(
      and(
        eq(inference_reservations.request_id, input.requestId),
        eq(inference_reservations.kilo_user_id, input.userId),
        sql`${inference_reservations.organization_id} IS NOT DISTINCT FROM ${input.organizationId ?? null}::uuid`,
        eq(inference_reservations.status, 'reserved')
      )
    )
    .returning();
  const row = finalized ?? (await lockReservation(tx, input));
  assertSettlement(row, actualCostMicrodollars);
  let debitStarted = false;
  let debited = false;
  const result = await writeUsage(async () => {
    if (!finalized || debitStarted) {
      throw new InferenceReservationError('terminal');
    }
    debitStarted = true;
    if (row.organization_id) {
      const payer = await updateOrganizationCreditUsage(
        tx,
        {
          userId: row.kilo_user_id,
          organizationId: row.organization_id,
          amountMicrodollars: actualCostMicrodollars,
          occurredAt: input.occurredAt,
        },
        row.amount_microdollars
      );
      if (!payer) throw new InferenceReservationError('counter_integrity');
      debited = true;
      return payer;
    }
    const [payer] = await tx
      .update(kilocode_users)
      .set({
        microdollars_used: sql`${kilocode_users.microdollars_used} + ${actualCostMicrodollars}`,
        inference_microdollars_held: sql`${kilocode_users.inference_microdollars_held} - ${row.amount_microdollars}`,
      })
      .where(
        and(
          eq(kilocode_users.id, row.kilo_user_id),
          sql`${kilocode_users.inference_microdollars_held} >= ${row.amount_microdollars}`
        )
      )
      .returning({
        newMicrodollarsUsed: kilocode_users.microdollars_used,
        kiloPassThreshold: kilocode_users.kilo_pass_threshold,
      });
    if (!payer) throw new InferenceReservationError('counter_integrity');
    debited = true;
    return { kind: 'personal', ...payer };
  });
  if (finalized && !debited) {
    throw new InferenceReservationError('counter_integrity');
  }
  return result;
}
