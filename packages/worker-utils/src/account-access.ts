import type { WorkerDb } from '@kilocode/db/client';
import {
  blacklisted_domains,
  organization_memberships,
  organization_user_limits,
  organization_user_usage,
  organizations,
  type Organization,
  type OrganizationUserLimitType,
} from '@kilocode/db/schema';
import type { OrganizationRole } from '@kilocode/db/schema-types';
import { and, eq, inArray, isNull, not, sql } from 'drizzle-orm';

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

// A membership resolves only for a live organization: the join excludes a soft-deleted
// organization, so the caller sees no role (and therefore no membership).
export async function findOrganizationMemberRole(
  db: AccountDb,
  organizationId: string,
  userId: string
): Promise<OrganizationRole | null> {
  const [membership] = await db
    .select({ role: organization_memberships.role })
    .from(organization_memberships)
    .innerJoin(organizations, eq(organizations.id, organization_memberships.organization_id))
    .where(
      and(
        eq(organization_memberships.organization_id, organizationId),
        eq(organization_memberships.kilo_user_id, userId),
        isNull(organizations.deleted_at)
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

/**
 * The organization a bouncer report identifies as the payer, with the totals bouncer judges: the
 * root of the organization family (the parent when the organization has one, else the organization
 * itself) and the sums over that root together with its child organizations. Organizations nest one
 * level deep, so a child is never itself a root of another family.
 */
export type OrganizationPayerFamily = {
  payerRootOrganizationId: string;
  /** `created_at` of the root organization. */
  payerRootCreatedAt: string;
  /** Sum of `microdollars_used` over the root and its children. */
  payerMicrodollarsUsed: number;
  /** Sum of `total_microdollars_acquired` over the root and its children. */
  payerTotalMicrodollarsAcquired: number;
};

// One row per organization holding its family root and the family's totals. It is correlated on the
// outer `organizations` row, so a caller reads the family in the same statement as its own row.
const organizationFamily = sql`(
  select
    root.id as root_organization_id,
    root.created_at as root_created_at,
    coalesce(sum(member.microdollars_used), 0) as microdollars_used,
    coalesce(sum(member.total_microdollars_acquired), 0) as total_microdollars_acquired
  from organizations root
  join organizations member
    on member.id = root.id or member.parent_organization_id = root.id
  where root.id = coalesce(${organizations.parent_organization_id}, ${organizations.id})
  group by root.id
) as organization_family`;

const organizationPayerFamily = {
  payerRootOrganizationId: sql<string>`organization_family.root_organization_id`,
  payerRootCreatedAt: sql<string>`organization_family.root_created_at`,
  payerMicrodollarsUsed: sql<number>`organization_family.microdollars_used`.mapWith(Number),
  payerTotalMicrodollarsAcquired:
    sql<number>`organization_family.total_microdollars_acquired`.mapWith(Number),
};

/**
 * The payer bouncer reports for an organization, from one query: the root of its family with the
 * family's totals. The inference path reads the same fields inside its balance-row statement; this
 * is for the charge and credit-event callers that are off that path.
 */
export async function findOrganizationPayerFamily(
  db: AccountDb,
  organizationId: string
): Promise<OrganizationPayerFamily | null> {
  const [row] = await db
    .select(organizationPayerFamily)
    .from(organizations)
    .innerJoinLateral(organizationFamily, sql`true`)
    .where(and(eq(organizations.id, organizationId), isNull(organizations.deleted_at)))
    .limit(1);
  return row ?? null;
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
> &
  OrganizationPayerFamily & {
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
      ...organizationPayerFamily,
    })
    .from(organizations)
    .innerJoinLateral(organizationFamily, sql`true`)
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
        isNull(organizations.deleted_at),
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

// Admins maintain the blocked email domains in the blacklisted_domains table. A blocked domain
// also blocks its subdomains.

// The longest DNS name. A longer suffix cannot be a blocked domain, so skipping it bounds the
// lookup for an arbitrarily long address without changing which addresses match.
const MAX_DOMAIN_LENGTH = 253;

/**
 * The label-boundary suffixes of an address's host, longest first. An address without '@' only
 * yields dotted suffixes, because the original matcher needed '@' for an exact-domain match.
 */
export function emailDomainSuffixes(email: string): string[] {
  const normalizedEmail = email.toLowerCase();
  const at = normalizedEmail.lastIndexOf('@');
  const host = normalizedEmail.slice(at + 1);
  const minStart = Math.max(0, host.length - MAX_DOMAIN_LENGTH);
  const suffixes: string[] = [];
  if (at !== -1 && minStart === 0 && host.length > 0) suffixes.push(host);
  for (
    let dot = host.indexOf('.', Math.max(0, minStart - 1));
    dot !== -1 && dot + 1 < host.length;
    dot = host.indexOf('.', dot + 1)
  ) {
    suffixes.push(host.slice(dot + 1));
  }
  return suffixes;
}

/** The given domains that are blocked, in one primary-key lookup. */
export async function findBlacklistedDomains(
  db: AccountDb,
  domains: readonly string[]
): Promise<Set<string>> {
  if (domains.length === 0) return new Set();
  const rows = await db
    .select({ domain: blacklisted_domains.domain })
    .from(blacklisted_domains)
    .where(inArray(blacklisted_domains.domain, [...domains]));
  return new Set(rows.map(row => row.domain));
}

// Access checks may lag an admin change by this long, as they did when every process cached
// the whole list for a minute.
export const EMAIL_DOMAIN_BLACKLIST_CACHE_TTL_MS = 60_000;
const EMAIL_DOMAIN_BLACKLIST_CACHE_LIMIT = 10_000;

/**
 * Caches blacklist answers in process, keyed by an address's longest suffix, which determines
 * all its other suffixes. Only answers are cached, never a pending lookup, because a Worker
 * cannot share one request's database I/O with another.
 */
export function createEmailDomainBlacklistCache({ now = () => Date.now() } = {}) {
  const cache = new Map<string, { expiresAt: number; blocked: boolean }>();

  return {
    async isBlacklisted(db: AccountDb, email: string): Promise<boolean> {
      const suffixes = emailDomainSuffixes(email);
      if (suffixes.length === 0) return false;
      const key = suffixes[0];
      const hit = cache.get(key);
      if (hit && hit.expiresAt > now()) return hit.blocked;

      const blocked = (await findBlacklistedDomains(db, suffixes)).size > 0;
      cache.delete(key);
      cache.set(key, { expiresAt: now() + EMAIL_DOMAIN_BLACKLIST_CACHE_TTL_MS, blocked });
      if (cache.size > EMAIL_DOMAIN_BLACKLIST_CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      return blocked;
    },
    clear(): void {
      cache.clear();
    },
  };
}

// Matches an address against an in-memory list, such as the signup TLD blocklist.
export function isEmailBlacklistedByDomain(
  email: string,
  blacklistedDomains: readonly string[] | undefined
): boolean {
  if (!blacklistedDomains?.length) return false;
  const index = new Set(blacklistedDomains.map(domain => domain.toLowerCase()));
  return emailDomainSuffixes(email).some(suffix => index.has(suffix));
}
