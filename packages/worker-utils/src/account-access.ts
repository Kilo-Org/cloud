import type { WorkerDb } from '@kilocode/db/client';
import {
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
}): number {
  return account.total_microdollars_acquired - account.microdollars_used;
}

export type OrganizationMemberBalanceRow = Pick<
  Organization,
  | 'total_microdollars_acquired'
  | 'microdollars_used'
  | 'settings'
  | 'require_seats'
  | 'plan'
  | 'auto_top_up_enabled'
  | 'next_credit_expiration_at'
  | 'created_at'
> & {
  microdollar_limit: number | null;
  microdollar_usage: number | null;
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
        eq(organization_user_usage.usage_date, sql`CURRENT_DATE`)
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
  >
): OrganizationMemberBalance {
  const organizationBalance = accountBalanceMicrodollars(row);
  if (row.require_seats || row.microdollar_limit == null) {
    return { balanceMicrodollars: organizationBalance, limitedByUserAllowance: false };
  }
  const remainingAllowance = row.microdollar_limit - (row.microdollar_usage ?? 0);
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

// The admin config is cached for a minute, so auth checks keep re-using the same
// array. Index it once per array reference instead of scanning it per call: a
// list with tens of thousands of entries costs one Set build per cache refresh,
// not one scan per sign-in.
const blacklistIndexCache = new WeakMap<readonly string[], Set<string>>();

function blacklistIndex(domains: readonly string[]): Set<string> {
  const cached = blacklistIndexCache.get(domains);
  if (cached) return cached;

  const index = new Set(domains.map(domain => domain.toLowerCase()));
  blacklistIndexCache.set(domains, index);
  return index;
}

// A blocked domain also blocks its subdomains.
export function isEmailBlacklistedByDomain(
  email: string,
  blacklistedDomains: readonly string[] | undefined
): boolean {
  if (!blacklistedDomains?.length) return false;

  const index = blacklistIndex(blacklistedDomains);
  const normalizedEmail = email.toLowerCase();
  const at = normalizedEmail.lastIndexOf('@');
  // An address without '@' is matched as if it were the host itself, which is
  // what the previous endsWith checks did.
  const host = at === -1 ? normalizedEmail : normalizedEmail.slice(at + 1);
  const labels = host.split('.');

  // Every label-boundary suffix of the host. '@' cannot appear inside a label,
  // so this matches exactly the strings the endsWith checks matched.
  for (let i = 0; i < labels.length; i++) {
    if (index.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}
