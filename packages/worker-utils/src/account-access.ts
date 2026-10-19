import type { WorkerDb } from '@kilocode/db/client';
import {
  inference_reservations,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
  type Organization,
  type OrganizationUserLimitType,
} from '@kilocode/db/schema';
import type { OrganizationRole } from '@kilocode/db/schema-types';
import { and, eq, not, sql } from 'drizzle-orm';
import * as z from 'zod';

// Account access rules shared by the Next.js gateway and Workers that authenticate Kilo users.

type AccountDb = Pick<WorkerDb, 'select'>;

// A token-bound organization is signed; the request header is mutable. Legacy and personal
// tokens select their organization context with the header.
export function requestOrganizationId(
  tokenOrganizationId: string | undefined,
  headerOrganizationId: string | null | undefined
): string | undefined {
  return tokenOrganizationId ?? headerOrganizationId ?? undefined;
}

// An account without a pepper accepts its tokens; otherwise a token must carry the current one.
export function isApiTokenPepperCurrent(
  accountPepper: string | null | undefined,
  tokenPepper: string | null | undefined
): boolean {
  return !accountPepper || accountPepper === tokenPepper;
}

export async function findOrganizationMemberRole(
  db: AccountDb,
  organizationId: string,
  userId: string
): Promise<OrganizationRole | null> {
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId)
      )
    )
    .limit(1);
  return membership?.role ?? null;
}

export async function isOrganizationMember(
  db: AccountDb,
  organizationId: string,
  userId: string
): Promise<boolean> {
  return (await findOrganizationMemberRole(db, organizationId, userId)) !== null;
}

export function accountBalanceMicrodollars(account: {
  total_microdollars_acquired: number;
  microdollars_used: number;
  inference_microdollars_held: number;
}): number {
  return (
    account.total_microdollars_acquired -
    account.microdollars_used -
    account.inference_microdollars_held
  );
}

export type OrganizationMemberBalanceRow = Pick<
  Organization,
  | 'total_microdollars_acquired'
  | 'microdollars_used'
  | 'inference_microdollars_held'
  | 'settings'
  | 'require_seats'
  | 'plan'
  | 'auto_top_up_enabled'
  | 'next_credit_expiration_at'
  | 'created_at'
> & {
  microdollar_limit: number | null;
  microdollar_usage: number | null;
  member_inference_microdollars_held: number;
};

// Billing managers manage credits but cannot spend them, so they have no member balance.
export async function findOrganizationMemberBalanceRow(
  db: AccountDb,
  organizationId: string,
  userId: string,
  limitType: OrganizationUserLimitType = 'daily'
): Promise<OrganizationMemberBalanceRow | null> {
  const [row] = await db
    .select({
      microdollar_limit: organization_user_limits.microdollar_limit,
      microdollar_usage: organization_user_usage.microdollar_usage,
      total_microdollars_acquired: organizations.total_microdollars_acquired,
      microdollars_used: organizations.microdollars_used,
      inference_microdollars_held: organizations.inference_microdollars_held,
      member_inference_microdollars_held: sql`
        CASE
          WHEN NOT ${organizations.require_seats} AND ${organization_user_limits.microdollar_limit} IS NOT NULL
          THEN (
            SELECT COALESCE(SUM(${inference_reservations.amount_microdollars}), 0)
            FROM ${inference_reservations}
            WHERE ${inference_reservations.organization_id} = ${organizations.id}
              AND ${inference_reservations.kilo_user_id} = ${userId}
              AND ${inference_reservations.status} = 'reserved'
          )
          ELSE 0
        END
      `.mapWith(Number),
      settings: organizations.settings,
      require_seats: organizations.require_seats,
      plan: organizations.plan,
      auto_top_up_enabled: organizations.auto_top_up_enabled,
      next_credit_expiration_at: organizations.next_credit_expiration_at,
      created_at: organizations.created_at,
    })
    .from(organizations)
    .innerJoin(
      organization_memberships,
      eq(organization_memberships.organization_id, organizations.id)
    )
    .leftJoin(
      organization_user_limits,
      and(
        eq(organization_user_limits.organization_id, organizations.id),
        eq(organization_user_limits.kilo_user_id, userId),
        eq(organization_user_limits.limit_type, limitType)
      )
    )
    .leftJoin(
      organization_user_usage,
      and(
        eq(organization_user_usage.organization_id, organizations.id),
        eq(organization_user_usage.kilo_user_id, userId),
        eq(organization_user_usage.limit_type, limitType),
        eq(organization_user_usage.usage_date, sql`(CURRENT_TIMESTAMP AT TIME ZONE 'UTC')::date`)
      )
    )
    .where(
      and(
        eq(organizations.id, organizationId),
        eq(organization_memberships.kilo_user_id, userId),
        not(eq(organization_memberships.role, 'billing_manager'))
      )
    )
    .limit(1);
  return row ?? null;
}

export type OrganizationMemberBalance = {
  balanceMicrodollars: number;
  // An organization top-up raises only the organization balance, so it clears the block only
  // while the member still has allowance left.
  limitedByUserAllowance: boolean;
};

// Seat-based organizations ignore member limits. Otherwise a member spends the smaller of the
// remaining daily allowance and the organization balance; both can be negative.
export function organizationMemberBalance(
  row: Pick<
    OrganizationMemberBalanceRow,
    | 'microdollar_limit'
    | 'microdollar_usage'
    | 'require_seats'
    | 'total_microdollars_acquired'
    | 'microdollars_used'
    | 'inference_microdollars_held'
    | 'member_inference_microdollars_held'
  >
): OrganizationMemberBalance {
  const organizationBalance = accountBalanceMicrodollars(row);
  if (row.require_seats || row.microdollar_limit == null) {
    return { balanceMicrodollars: organizationBalance, limitedByUserAllowance: false };
  }
  const remainingAllowance =
    row.microdollar_limit - (row.microdollar_usage ?? 0) - row.member_inference_microdollars_held;
  return {
    balanceMicrodollars: Math.min(remainingAllowance, organizationBalance),
    limitedByUserAllowance: remainingAllowance <= 0,
  };
}

// Paid usage requires a positive balance. Free models and BYOK requests skip this check.
export function canSpendPaidUsage(balance: number): boolean {
  return balance > 0;
}

// Admins maintain the blocked email domains in Redis; an empty list falls back to the
// deployment's BLACKLIST_DOMAINS setting.
export const BLACKLISTED_DOMAINS_REDIS_KEY = 'admin:blacklisted-domains';

export const BlacklistDomainsConfigSchema = z.object({
  domains: z.array(z.string()),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
});

export function blacklistedDomainsFromConfig(
  raw: string | null,
  fallbackDomains: string[]
): string[] {
  if (!raw) return fallbackDomains;
  const { domains } = BlacklistDomainsConfigSchema.parse(JSON.parse(raw));
  return domains.length > 0 ? domains : fallbackDomains;
}

// A blocked domain also blocks its subdomains.
export function isEmailBlacklistedByDomain(
  email: string,
  blacklistedDomains: readonly string[] | undefined
): boolean {
  const normalizedEmail = email.toLowerCase();
  return (
    blacklistedDomains?.some(domain => {
      const normalizedDomain = domain.toLowerCase();
      return (
        normalizedEmail.endsWith(`@${normalizedDomain}`) ||
        normalizedEmail.endsWith(`.${normalizedDomain}`)
      );
    }) ?? false
  );
}
