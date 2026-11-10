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
import { and, asc, eq, inArray, isNull, not, sql } from 'drizzle-orm';
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

// The legacy snapshot is only a temporary metadata fallback until an admin save retires it.
export const BLACKLISTED_DOMAINS_REDIS_KEY = 'admin:blacklisted-domains';
export const BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY = 'admin:blacklisted-domains:settings';
// Holds the config's updated_at. The admin save writes both keys in one MSET.
export const BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY = 'admin:blacklisted-domains:updated-at';

// Bounds how long a write that skips the updated_at key, such as a direct Redis edit or a save
// from a web deployment older than that key, can go unnoticed.
const BLACKLISTED_DOMAINS_FULL_READ_INTERVAL_MS = 10 * 60_000;

// Legacy parsing stays bounded; selective Postgres access checks do not use this limit.
export const MAX_BLACKLIST_DOMAINS = 200_000;

export const BlacklistDomainsConfigSchema = z.object({
  domains: z.array(z.string()).max(MAX_BLACKLIST_DOMAINS),
  // TLDs whose new signups are refused. Optional because configs written
  // before this field existed must keep parsing; readers fall back to the
  // deployment default in that case. An empty array means "no TLD blocked".
  blocked_signup_tlds: z.array(z.string()).optional(),
  updated_at: z.string().nullable(),
  updated_by: z.string().nullable(),
  updated_by_email: z.string().nullable(),
});

export type BlacklistDomainsConfig = z.infer<typeof BlacklistDomainsConfigSchema>;

export type BlacklistDomainsConfigSnapshot = {
  config: BlacklistDomainsConfig | null;
  fullReadAt: number;
  // Entries a stored list held beyond the cap; 0 when the whole list is used.
  droppedDomains: number;
};

export type ParsedBlacklistDomainsConfig = {
  config: BlacklistDomainsConfig;
  droppedDomains: number;
};

/**
 * Parses one stored blocklist config and keeps its first MAX_BLACKLIST_DOMAINS
 * entries, reporting how many entries it left out so the reader can surface a
 * list that is longer than the cap.
 */
export function parseBlacklistDomainsConfig(value: unknown): ParsedBlacklistDomainsConfig {
  if (value !== null && typeof value === 'object' && 'domains' in value) {
    const { domains } = value;
    if (Array.isArray(domains) && domains.length > MAX_BLACKLIST_DOMAINS) {
      return {
        config: BlacklistDomainsConfigSchema.parse({
          ...value,
          domains: domains.slice(0, MAX_BLACKLIST_DOMAINS),
        }),
        droppedDomains: domains.length - MAX_BLACKLIST_DOMAINS,
      };
    }
  }

  return { config: BlacklistDomainsConfigSchema.parse(value), droppedDomains: 0 };
}

/**
 * Refreshes the small signup/operator settings, never the legacy domain snapshot.
 */
export async function refreshBlacklistDomainsConfig(
  redisGet: (key: string) => Promise<string | null>,
  previous: BlacklistDomainsConfigSnapshot | null,
  now: number
): Promise<BlacklistDomainsConfigSnapshot> {
  const previousUpdatedAt = previous?.config?.updated_at;
  if (
    previous &&
    previousUpdatedAt != null &&
    now - previous.fullReadAt < BLACKLISTED_DOMAINS_FULL_READ_INTERVAL_MS &&
    (await redisGet(BLACKLISTED_DOMAINS_UPDATED_AT_REDIS_KEY)) === previousUpdatedAt
  ) {
    return previous;
  }

  const raw = await redisGet(BLACKLISTED_DOMAINS_SETTINGS_REDIS_KEY);
  if (!raw) {
    return { config: null, fullReadAt: now, droppedDomains: 0 };
  }

  const { config, droppedDomains } = parseBlacklistDomainsConfig(JSON.parse(raw));
  return { config, fullReadAt: now, droppedDomains };
}

export function blacklistedDomainsFromConfig(
  config: BlacklistDomainsConfig | null,
  fallbackDomains: string[]
): string[] {
  return config && config.domains.length > 0 ? config.domains : fallbackDomains;
}

export function blockedSignupTldsFromConfig(
  config: BlacklistDomainsConfig | null,
  fallbackTlds: string[]
): string[] {
  return config?.blocked_signup_tlds ?? fallbackTlds;
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
  const host = at === -1 ? normalizedEmail : normalizedEmail.slice(at + 1);
  const labels = host.split('.');

  // An address without '@' can only match on a dotted suffix, because the
  // previous implementation needed '@' for an exact-domain match.
  const firstLabel = at === -1 ? 1 : 0;

  // Every label-boundary suffix of the host. '@' cannot appear inside a label,
  // so these are exactly the strings the previous endsWith checks matched.
  for (let i = firstLabel; i < labels.length; i++) {
    if (index.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

export const DOMAIN_BLACKLIST_CACHE_TTL_SECONDS = 60;
export const DOMAIN_BLACKLIST_QUERY_TIMEOUT_MS = 1000;
export const DOMAIN_BLACKLIST_CACHE_TIMEOUT_MS = 200;
export const DOMAIN_BLACKLIST_GENERATION_REDIS_KEY = 'domain-blacklist:generation';

async function blacklistOperation<T>(
  operation: PromiseLike<T>,
  timeout: number,
  message: string
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export type DomainBlacklistCache = {
  get: (key: string) => Promise<string | null>;
  set: (key: string, value: string, ttlSeconds: number) => Promise<unknown>;
  defer: (write: () => Promise<void>) => void;
  onError: (error: unknown) => void;
};

export function emailDomainSuffixes(email: string): string[] | null {
  const normalized = email.toLowerCase();
  const at = normalized.lastIndexOf('@');
  const host = at === -1 ? normalized : normalized.slice(at + 1);
  const labels = host.split('.');
  if (host.length > 1024 || labels.length > 128) {
    return null;
  }
  return labels
    .slice(at === -1 ? 1 : 0)
    .map((_, index) => labels.slice(index + (at === -1 ? 1 : 0)).join('.'));
}

export async function isEmailDomainBlacklisted(
  db: AccountDb,
  email: string,
  fallbackDomains: string[],
  cache: DomainBlacklistCache
): Promise<boolean> {
  const suffixes = emailDomainSuffixes(email);
  if (suffixes === null) return true;
  if (suffixes.length === 0) return false;

  let key: string | undefined;
  let pgBlocked: boolean | undefined;
  try {
    const rawGeneration = await blacklistOperation(
      cache.get(DOMAIN_BLACKLIST_GENERATION_REDIS_KEY),
      DOMAIN_BLACKLIST_CACHE_TIMEOUT_MS,
      'Domain blacklist generation lookup timed out'
    );
    const generation = rawGeneration === null ? 'initial' : z.uuid().parse(rawGeneration);
    key = `domain-blacklist:${generation}:${email.includes('@') ? 'host' : 'suffix'}:${encodeURIComponent(suffixes[0])}`;
    const cached = await blacklistOperation(
      cache.get(key),
      DOMAIN_BLACKLIST_CACHE_TIMEOUT_MS,
      'Domain blacklist cache lookup timed out'
    );
    if (cached === '1' || cached === '0') pgBlocked = cached === '1';
  } catch (error) {
    cache.onError(error);
  }

  if (pgBlocked === undefined) {
    const matches = await blacklistOperation(
      db
        .select({ domain: blacklisted_domains.domain })
        .from(blacklisted_domains)
        .where(inArray(blacklisted_domains.domain, suffixes))
        .limit(1),
      DOMAIN_BLACKLIST_QUERY_TIMEOUT_MS,
      'Domain blacklist database lookup timed out'
    );
    pgBlocked = matches.length > 0;
    const expiresAt = Date.now() + DOMAIN_BLACKLIST_CACHE_TTL_SECONDS * 1000;
    if (key !== undefined) {
      const cacheKey = key;
      const value = pgBlocked ? '1' : '0';
      try {
        cache.defer(async () => {
          const ttlSeconds = Math.min(
            DOMAIN_BLACKLIST_CACHE_TTL_SECONDS,
            Math.floor((expiresAt - Date.now()) / 1000)
          );
          if (ttlSeconds <= 0) return;
          try {
            await blacklistOperation(
              cache.set(cacheKey, value, ttlSeconds),
              DOMAIN_BLACKLIST_CACHE_TIMEOUT_MS,
              'Domain blacklist cache write timed out'
            );
          } catch (error) {
            cache.onError(error);
          }
        });
      } catch (error) {
        cache.onError(error);
      }
    }
  }
  if (pgBlocked) return true;
  if (!isEmailBlacklistedByDomain(email, fallbackDomains)) return false;

  const configuredDomains = await blacklistOperation(
    db
      .select({ domain: blacklisted_domains.domain })
      .from(blacklisted_domains)
      .orderBy(asc(blacklisted_domains.domain))
      .limit(1),
    DOMAIN_BLACKLIST_QUERY_TIMEOUT_MS,
    'Domain blacklist database lookup timed out'
  );
  return configuredDomains.length === 0;
}
