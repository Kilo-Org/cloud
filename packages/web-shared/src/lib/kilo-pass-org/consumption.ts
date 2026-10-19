import 'server-only';

import {
  credit_transactions,
  kilo_pass_org_agreements,
  kilo_pass_org_allocation_plan_rows,
  kilo_pass_org_allocation_plans,
  kilo_pass_org_audit_records,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_qualifying_spend_events,
  organizations,
} from '@kilocode/db/schema';
import { KiloPassOrgBonusMode, KiloPassOrgIssuanceKind } from '@kilocode/db/schema-types';
import type { DrizzleTransaction } from '@kilocode/web-shared/lib/drizzle';
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  mutateOrganizationUsage,
  type OrganizationUsageMutationResult,
} from '@kilocode/web-shared/lib/organizations/organization-usage';
import type { InferenceSettlementPayer } from '@kilocode/db/inference-reservations';

export type OrganizationConsumptionSource = 'ai-gateway' | 'exa';

export type RecordOrganizationConsumptionInput = {
  organizationId: string;
  kiloUserId: string;
  amountMicrodollars: number;
  occurredAt: string;
  source: OrganizationConsumptionSource;
  sourceId: string;
};

export type OrganizationConsumptionResult = {
  recorded: boolean;
  organizationUsage: OrganizationUsageMutationResult;
};

type QualifyingSpendMutationResult = { event_inserted: boolean } & (
  | Pick<
      typeof kilo_pass_org_issuance_snapshots.$inferSelect,
      | 'id'
      | 'agreement_id'
      | 'window_end'
      | 'bonus_mode'
      | 'bonus_unlocked_at'
      | 'qualifying_spend_microdollars'
      | 'unlock_spend_microdollars'
      | 'bonus_credit_microdollars'
    >
  | { id: null }
);

const noAlert: OrganizationUsageMutationResult = {
  crossedMinimumBalance: false,
  recipients: [],
  minimumBalanceMicrodollars: null,
};

function sourceIdentity(input: RecordOrganizationConsumptionInput): string {
  return `kpo:consumption:${input.source}:${input.sourceId}`;
}

/**
 * Records normal organization usage for every charge. When the organization is a
 * current or planned Kilo Pass allocation container, it also writes an idempotent
 * qualifying debit. `credit_category` is the durable source identity because
 * credit_transactions has no source-record foreign key. Its existing uniqueness
 * index is scoped to the acting user and category, so source IDs must be globally
 * stable for their source system.
 */
export async function recordOrganizationConsumption(
  tx: DrizzleTransaction,
  input: RecordOrganizationConsumptionInput,
  debitPayer?: () => Promise<InferenceSettlementPayer>
): Promise<OrganizationConsumptionResult> {
  if (!Number.isSafeInteger(input.amountMicrodollars) || input.amountMicrodollars <= 0) {
    return { recorded: false, organizationUsage: noAlert };
  }

  const {
    rows: [agreement],
  } = await tx.execute<{ qualifies: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM ${kilo_pass_org_agreements}
      WHERE ${kilo_pass_org_agreements.parent_organization_id} = ${input.organizationId}
        AND ${kilo_pass_org_agreements.state} <> 'ended'
    ) OR EXISTS (
      SELECT 1 FROM ${kilo_pass_org_allocation_plan_rows}
      JOIN ${kilo_pass_org_allocation_plans}
        ON ${kilo_pass_org_allocation_plans.id} = ${kilo_pass_org_allocation_plan_rows.allocation_plan_id}
      JOIN ${kilo_pass_org_agreements}
        ON ${kilo_pass_org_agreements.id} = ${kilo_pass_org_allocation_plans.agreement_id}
      WHERE ${kilo_pass_org_allocation_plan_rows.allocation_container_organization_id} = ${input.organizationId}
        AND ${kilo_pass_org_allocation_plan_rows.pass_capacity} > 0
        AND ${kilo_pass_org_agreements.state} <> 'ended'
    ) AS qualifies
  `);
  if (!agreement) throw new Error('Organization consumption eligibility was not returned');

  if (!agreement.qualifies) {
    return {
      recorded: true,
      organizationUsage: await mutateOrganizationUsage(
        tx,
        {
          kilo_user_id: input.kiloUserId,
          organization_id: input.organizationId,
          cost: input.amountMicrodollars,
          created_at: input.occurredAt,
        },
        debitPayer
      ),
    };
  }

  const identity = sourceIdentity(input);
  const [credit] = await tx
    .insert(credit_transactions)
    .values({
      kilo_user_id: input.kiloUserId,
      organization_id: input.organizationId,
      amount_microdollars: -input.amountMicrodollars,
      is_free: false,
      description: `Organization consumption (${input.source})`,
      credit_category: identity,
      check_category_uniqueness: true,
      created_at: input.occurredAt,
    })
    .onConflictDoNothing()
    .returning({ id: credit_transactions.id });

  // The category uniqueness index makes a replay a no-op for every financial
  // side effect below. Do not infer an existing source from mutable usage rows.
  if (!credit) return { recorded: false, organizationUsage: noAlert };

  const organizationUsage = await mutateOrganizationUsage(
    tx,
    {
      kilo_user_id: input.kiloUserId,
      organization_id: input.organizationId,
      cost: input.amountMicrodollars,
      created_at: input.occurredAt,
    },
    debitPayer
  );

  const snapshots = await tx
    .select({ id: kilo_pass_org_issuance_snapshots.id })
    .from(kilo_pass_org_issuance_snapshots)
    .where(
      and(
        eq(
          kilo_pass_org_issuance_snapshots.allocation_container_organization_id,
          input.organizationId
        ),
        inArray(kilo_pass_org_issuance_snapshots.kind, [
          KiloPassOrgIssuanceKind.Regular,
          KiloPassOrgIssuanceKind.Supplement,
          KiloPassOrgIssuanceKind.Bridge,
        ]),
        lte(kilo_pass_org_issuance_snapshots.qualifying_spend_starts_at, input.occurredAt),
        gt(kilo_pass_org_issuance_snapshots.window_end, input.occurredAt)
      )
    )
    .for('update');

  for (const snapshot of snapshots) {
    const {
      rows: [updated],
    } = await tx.execute<QualifyingSpendMutationResult>(sql`
      WITH inserted_event AS (
        INSERT INTO ${kilo_pass_org_qualifying_spend_events}
          (issuance_snapshot_id, allocation_container_organization_id,
           credit_transaction_id, spent_microdollars, occurred_at)
        VALUES (
          ${snapshot.id}, ${input.organizationId}, ${credit.id},
          ${input.amountMicrodollars}, ${input.occurredAt}
        )
        ON CONFLICT DO NOTHING
        RETURNING id
      ), updated_snapshot AS (
        UPDATE ${kilo_pass_org_issuance_snapshots}
        SET qualifying_spend_microdollars =
          ${kilo_pass_org_issuance_snapshots.qualifying_spend_microdollars} + ${input.amountMicrodollars}
        WHERE ${kilo_pass_org_issuance_snapshots.id} = ${snapshot.id}
          AND EXISTS (SELECT 1 FROM inserted_event)
        RETURNING
          id,
          agreement_id,
          window_end::text,
          bonus_mode,
          bonus_unlocked_at::text,
          qualifying_spend_microdollars::float8,
          unlock_spend_microdollars::float8,
          bonus_credit_microdollars::float8
      )
      SELECT EXISTS (SELECT 1 FROM inserted_event) AS event_inserted, updated_snapshot.*
      FROM (VALUES (1)) AS result(anchor)
      LEFT JOIN updated_snapshot ON true
    `);
    if (!updated) throw new Error('Organization consumption qualifying spend was not returned');
    if (!updated.event_inserted) continue;
    if (updated.id === null)
      throw new Error('organization pass snapshot disappeared during consumption');

    const expired = new Date(updated.window_end) < new Date();
    if (
      updated.bonus_mode !== KiloPassOrgBonusMode.AfterBase ||
      updated.bonus_unlocked_at !== null ||
      updated.qualifying_spend_microdollars < updated.unlock_spend_microdollars
    ) {
      continue;
    }

    if (expired) {
      await tx
        .update(kilo_pass_org_issuance_snapshots)
        .set({ repair_completed_at: input.occurredAt })
        .where(eq(kilo_pass_org_issuance_snapshots.id, updated.id));
      await tx
        .insert(kilo_pass_org_audit_records)
        .values({
          agreement_id: updated.agreement_id,
          action: 'bonus_missed_after_expiry',
          reason: 'qualifying_spend_repair',
          after_json: {
            issuanceSnapshotId: updated.id,
            qualifyingSpendMicrodollars: updated.qualifying_spend_microdollars,
          },
          idempotency_key: `kpo:expired-bonus-miss:${updated.id}`,
        })
        .onConflictDoNothing();
      continue;
    }

    const [organization] = await tx
      .select({ microdollarsUsed: organizations.microdollars_used })
      .from(organizations)
      .where(eq(organizations.id, input.organizationId))
      .for('update');
    if (!organization) throw new Error('organization disappeared during bonus unlock');
    const bonusIdentity = `kpo:bonus-unlock:${updated.id}`;
    const [bonus] = await tx
      .insert(credit_transactions)
      .values({
        kilo_user_id: input.kiloUserId,
        organization_id: input.organizationId,
        amount_microdollars: updated.bonus_credit_microdollars,
        is_free: true,
        description: 'Kilo Pass organization earned bonus',
        credit_category: bonusIdentity,
        check_category_uniqueness: true,
        created_at: input.occurredAt,
        expiry_date: updated.window_end,
        expiration_baseline_microdollars_used: organization.microdollarsUsed,
        original_baseline_microdollars_used: organization.microdollarsUsed,
      })
      .onConflictDoNothing()
      .returning({ id: credit_transactions.id });
    if (!bonus)
      throw new Error('organization pass bonus identity already exists without a snapshot unlock');

    await tx
      .update(organizations)
      .set({
        total_microdollars_acquired: sql`${organizations.total_microdollars_acquired} + ${updated.bonus_credit_microdollars}`,
        microdollars_balance: sql`${organizations.microdollars_balance} + ${updated.bonus_credit_microdollars}`,
        next_credit_expiration_at: sql`COALESCE(LEAST(${organizations.next_credit_expiration_at}, ${updated.window_end}), ${updated.window_end})`,
      })
      .where(eq(organizations.id, input.organizationId));
    await tx
      .update(kilo_pass_org_issuance_snapshots)
      .set({ bonus_unlocked_at: input.occurredAt, bonus_credit_transaction_id: bonus.id })
      .where(
        and(
          eq(kilo_pass_org_issuance_snapshots.id, updated.id),
          isNull(kilo_pass_org_issuance_snapshots.bonus_unlocked_at)
        )
      );
  }

  return { recorded: true, organizationUsage };
}
