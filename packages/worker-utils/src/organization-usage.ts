import { toMicrodollars } from './microdollars';
import type { WorkerDb } from '@kilocode/db/client';
import type {
  MicrodollarUsage,
  Organization,
  OrganizationUserLimitType,
} from '@kilocode/db/schema';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import {
  organization_user_usage,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import { sql } from 'drizzle-orm';
import {
  directOrganizationMembershipCondition,
  liveOrganizationCondition,
} from './organization-membership';

export type OrganizationTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

export type OrganizationUsageMutationResult = {
  crossedMinimumBalance: boolean;
  recipients: string[];
  minimumBalanceMicrodollars: number | null;
  autoTopUpOrganization?: Pick<
    Organization,
    'id' | 'auto_top_up_enabled' | 'total_microdollars_acquired' | 'microdollars_used'
  >;
};

/**
 * A result for a call that recorded no balance effect. Each call returns its own
 * object, so a caller that appends to `recipients` cannot change what a later
 * call receives.
 */
export function emptyOrganizationUsageResult(): OrganizationUsageMutationResult {
  return {
    crossedMinimumBalance: false,
    recipients: [],
    minimumBalanceMicrodollars: null,
  };
}

export type OrganizationUsageMutationInput = Pick<
  MicrodollarUsage,
  'kilo_user_id' | 'organization_id' | 'cost' | 'created_at'
>;

/**
 * Charges the organization for one usage row and records the member's daily
 * usage against the organization's per-user limit.
 *
 * The balance update is authoritative for the charge. It runs for every usage
 * that names an organization, including a soft-deleted organization and a
 * caller who holds no membership row. The per-user daily row is derived from
 * that charge, so it accrues only for a direct membership in a live
 * organization — the same two conditions the read paths apply. The result
 * reports the balance effects only; it does not say whether the per-user row
 * was written.
 *
 * Both rows are hot under concurrent usage, so both writes run in one statement:
 * the transaction holds them for one round trip instead of two. The balance
 * update reads the per-user upsert's result, which makes PostgreSQL finish the
 * upsert before it locks the `organizations` row. That keeps the lock order
 * `organization_user_usage` then `organizations`.
 */
export async function mutateOrganizationUsage(
  tx: OrganizationTransaction,
  usage: OrganizationUsageMutationInput
): Promise<OrganizationUsageMutationResult> {
  const { cost, kilo_user_id, organization_id, created_at } = usage;
  if (!organization_id) return emptyOrganizationUsageResult();

  const limitType: OrganizationUserLimitType = 'daily';
  type OrganizationBalanceRow = {
    total_microdollars_acquired: bigint | number;
    previous_microdollars_used: bigint | number;
    new_microdollars_used: bigint | number;
    settings: OrganizationSettings | null;
    auto_top_up_enabled: boolean;
  };
  const balanceResult = await tx.execute<OrganizationBalanceRow>(sql`
    WITH member_usage AS (
      INSERT INTO ${organization_user_usage} (
        organization_id,
        kilo_user_id,
        usage_date,
        limit_type,
        microdollar_usage,
        created_at,
        updated_at
      )
      SELECT
        ${organization_id},
        ${kilo_user_id},
        (${created_at}::timestamptz AT TIME ZONE 'UTC')::date,
        ${limitType},
        ${cost},
        NOW(),
        NOW()
      WHERE EXISTS (
        SELECT 1
        FROM ${organization_memberships}
        WHERE ${directOrganizationMembershipCondition({
          organizationId: organization_id,
          kiloUserId: kilo_user_id,
        })}
      )
        AND EXISTS (
          SELECT 1
          FROM ${organizations}
          WHERE ${organizations.id} = ${organization_id}
            AND ${liveOrganizationCondition(organizations)}
        )
      ON CONFLICT (organization_id, kilo_user_id, limit_type, usage_date)
      DO UPDATE SET
        microdollar_usage = ${organization_user_usage.microdollar_usage} + ${cost},
        updated_at = NOW()
      RETURNING 1
    )
    UPDATE ${organizations}
    SET
      microdollars_used = ${organizations.microdollars_used} + ${cost},
      microdollars_balance = ${organizations.microdollars_balance} - ${cost},
      updated_at = NOW()
    WHERE ${organizations.id} = ${organization_id}
      AND (SELECT count(*) FROM member_usage) >= 0
    RETURNING
      ${organizations.total_microdollars_acquired} AS total_microdollars_acquired,
      ${organizations.microdollars_used} - ${cost} AS previous_microdollars_used,
      ${organizations.microdollars_used} AS new_microdollars_used,
      ${organizations.settings} AS settings,
      ${organizations.auto_top_up_enabled} AS auto_top_up_enabled
  `);

  const [orgRow] = balanceResult.rows;
  if (!orgRow) return emptyOrganizationUsageResult();
  const orgData = {
    ...orgRow,
    total_microdollars_acquired: Number(orgRow.total_microdollars_acquired),
    previous_microdollars_used: Number(orgRow.previous_microdollars_used),
    new_microdollars_used: Number(orgRow.new_microdollars_used),
  };

  const currentBalance = orgData.total_microdollars_acquired - orgData.previous_microdollars_used;
  const newBalance = orgData.total_microdollars_acquired - orgData.new_microdollars_used;
  const minimumBalance = orgData.settings?.minimum_balance
    ? toMicrodollars(orgData.settings.minimum_balance)
    : null;
  const crossedMinimumBalance =
    minimumBalance != null && currentBalance >= minimumBalance && newBalance < minimumBalance;
  const recipients = crossedMinimumBalance
    ? (orgData.settings?.minimum_balance_alert_email ?? [])
    : [];

  return {
    crossedMinimumBalance,
    recipients,
    minimumBalanceMicrodollars: minimumBalance,
    ...(cost > 0 && orgData.auto_top_up_enabled
      ? {
          autoTopUpOrganization: {
            id: organization_id,
            auto_top_up_enabled: orgData.auto_top_up_enabled,
            total_microdollars_acquired: orgData.total_microdollars_acquired,
            microdollars_used: orgData.new_microdollars_used,
          },
        }
      : {}),
  };
}
