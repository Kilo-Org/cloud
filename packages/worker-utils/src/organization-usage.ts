import { toMicrodollars } from './microdollars';
import type { WorkerDb } from '@kilocode/db/client';
import type { MicrodollarUsage, OrganizationUserLimitType } from '@kilocode/db/schema';
import type { OrganizationSettings } from '@kilocode/db/schema-types';
import {
  organization_user_usage,
  organizations,
  organization_memberships,
} from '@kilocode/db/schema';
import { eq, sql } from 'drizzle-orm';

export type OrganizationTransaction = Parameters<Parameters<WorkerDb['transaction']>[0]>[0];

export type OrganizationUsageMutationResult = {
  crossedMinimumBalance: boolean;
  recipients: string[];
  minimumBalanceMicrodollars: number | null;
};

const NO_ORGANIZATION_BALANCE_ALERT: OrganizationUsageMutationResult = {
  crossedMinimumBalance: false,
  recipients: [],
  minimumBalanceMicrodollars: null,
};

export type OrganizationUsageMutationInput = Pick<
  MicrodollarUsage,
  'kilo_user_id' | 'organization_id' | 'cost' | 'created_at'
>;

export async function mutateOrganizationUsage(
  tx: OrganizationTransaction,
  usage: OrganizationUsageMutationInput
): Promise<OrganizationUsageMutationResult> {
  const { cost, kilo_user_id, organization_id, created_at } = usage;
  if (!organization_id) return NO_ORGANIZATION_BALANCE_ALERT;

  const limitType: OrganizationUserLimitType = 'daily';
  await tx.execute(sql`
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
      WHERE ${organization_memberships.organization_id} = ${organization_id}
        AND ${organization_memberships.kilo_user_id} = ${kilo_user_id}
    )
      AND EXISTS (
        SELECT 1
        FROM ${organizations}
        WHERE ${organizations.id} = ${organization_id}
      )
    ON CONFLICT (organization_id, kilo_user_id, limit_type, usage_date)
    DO UPDATE SET
      microdollar_usage = ${organization_user_usage.microdollar_usage} + ${cost},
      updated_at = NOW()
  `);

  type OrganizationBalanceRow = {
    total_microdollars_acquired: number;
    previous_microdollars_used: number;
    new_microdollars_used: number;
    settings: OrganizationSettings | null;
  };
  const balanceRows: OrganizationBalanceRow[] = await tx
    .update(organizations)
    .set({
      microdollars_used: sql`${organizations.microdollars_used} + ${cost}`,
      microdollars_balance: sql`${organizations.microdollars_balance} - ${cost}`,
    })
    .where(eq(organizations.id, organization_id))
    .returning({
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      previous_microdollars_used: sql<number>`${organizations.microdollars_used} - ${cost}`.mapWith(
        Number
      ),
      new_microdollars_used: organizations.microdollars_used,
      settings: organizations.settings,
    });

  const [orgData] = balanceRows;
  if (!orgData) return NO_ORGANIZATION_BALANCE_ALERT;

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
  };
}
