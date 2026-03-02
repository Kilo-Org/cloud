import type { OptionalError } from '@/lib/maybe-result';
import type { Awaitable } from 'next-auth';
import { db } from '@/lib/drizzle';
import {
  credit_transactions,
  organization_memberships,
  type Organization,
} from '@kilocode/db/schema';
import { eq, and, count } from 'drizzle-orm';

export type OrganizationRequirement = (orgInfo: Organization) => Awaitable<OptionalError<string>>;

export const team_topup_bonus_requirement: OrganizationRequirement = async orgInfo => {
  // Check based on actual organization member count (active memberships only)
  const [{ memberCount }] = await db
    .select({ memberCount: count() })
    .from(organization_memberships)
    .where(eq(organization_memberships.organization_id, orgInfo.id));

  if (memberCount < 2) {
    return {
      success: false,
      error: 'Organization must have multiple members to unlock this promotion',
    };
  }

  const existingTransactions = await db
    .select({ id: credit_transactions.id })
    .from(credit_transactions)
    .where(
      and(
        eq(credit_transactions.organization_id, orgInfo.id),
        eq(credit_transactions.credit_category, 'team-topup-bonus-2025'),
        eq(credit_transactions.is_free, true)
      )
    )
    .limit(1);

  if (existingTransactions.length > 0) {
    return {
      success: false,
      error: "Organization has already received the 'team-topup-bonus-2025' promotion",
    };
  }

  return { success: true };
};
