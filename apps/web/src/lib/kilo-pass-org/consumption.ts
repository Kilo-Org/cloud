import 'server-only';

import {
  credit_transactions,
  kilo_pass_org_audit_records,
  kilo_pass_org_issuance_snapshots,
  kilo_pass_org_qualifying_spend_events,
  organizations,
} from '@kilocode/db/schema';
import { KiloPassOrgBonusMode, KiloPassOrgIssuanceKind } from '@kilocode/db/schema-types';
import type { DrizzleTransaction } from '@/lib/drizzle';
import { and, eq, gt, inArray, isNull, lte, sql } from 'drizzle-orm';
import {
  mutateOrganizationUsage,
  type OrganizationUsageMutationResult,
} from '@/lib/organizations/organization-usage';

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

const noAlert: OrganizationUsageMutationResult = {
  crossedMinimumBalance: false,
  recipients: [],
  minimumBalanceMicrodollars: null,
};

function sourceIdentity(input: RecordOrganizationConsumptionInput): string {
  return `kpo:consumption:${input.source}:${input.sourceId}`;
}

/**
 * Records a charge against an organization exactly once at the source's financial
 * transaction boundary. `credit_category` is the durable source identity because
 * credit_transactions has no source-record foreign key. Its existing uniqueness
 * index is scoped to the acting user and category, so source IDs must be globally
 * stable for their source system.
 */
export async function recordOrganizationConsumption(
  tx: DrizzleTransaction,
  input: RecordOrganizationConsumptionInput
): Promise<OrganizationConsumptionResult> {
  if (!Number.isSafeInteger(input.amountMicrodollars) || input.amountMicrodollars <= 0) {
    return { recorded: false, organizationUsage: noAlert };
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

  const organizationUsage = await mutateOrganizationUsage(tx, {
    kilo_user_id: input.kiloUserId,
    organization_id: input.organizationId,
    cost: input.amountMicrodollars,
    created_at: input.occurredAt,
  });

  const snapshots = await tx
    .select()
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
    const [event] = await tx
      .insert(kilo_pass_org_qualifying_spend_events)
      .values({
        issuance_snapshot_id: snapshot.id,
        allocation_container_organization_id: input.organizationId,
        credit_transaction_id: credit.id,
        spent_microdollars: input.amountMicrodollars,
        occurred_at: input.occurredAt,
      })
      .onConflictDoNothing()
      .returning({ id: kilo_pass_org_qualifying_spend_events.id });
    if (!event) continue;

    const [updated] = await tx
      .update(kilo_pass_org_issuance_snapshots)
      .set({
        qualifying_spend_microdollars: sql`${kilo_pass_org_issuance_snapshots.qualifying_spend_microdollars} + ${input.amountMicrodollars}`,
      })
      .where(eq(kilo_pass_org_issuance_snapshots.id, snapshot.id))
      .returning();
    if (!updated) throw new Error('organization pass snapshot disappeared during consumption');

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
