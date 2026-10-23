import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, eq, inArray, isNotNull, isNull, sql, type SQL } from 'drizzle-orm';

/** A distinct email domain whose users match the blacklist, with its count. */
export type BlacklistedEmailDomain = {
  email_domain: string;
  count: number;
};

/**
 * Matches one email domain against blacklist entries. An entry matches the
 * domain itself or any of its parent domains, so blocking `example.com` also
 * matches `sub.example.com` while `notexample.com` stays unmatched. Domains
 * are compared on label boundaries, never as raw string suffixes.
 */
export function emailDomainMatchesBlacklist(
  domain: string,
  blacklistedDomains: ReadonlySet<string>
): boolean {
  const labels = domain.toLowerCase().split('.');
  for (let i = 0; i < labels.length; i++) {
    if (blacklistedDomains.has(labels.slice(i).join('.'))) return true;
  }
  return false;
}

/**
 * Blockable, unblocked users grouped by email domain, limited to domains that
 * match the blacklist.
 *
 * Matching every blacklist entry against every user is not viable: an imported
 * list of ~137k entries pushed `email_domain LIKE ANY (patterns)` past a
 * two-minute statement timeout. The users table holds far fewer distinct email
 * domains (~65k) than rows, so one grouped scan plus an in-process label match
 * returns in well under a second and hands the callers a small domain list for
 * the indexed `email_domain` lookups that follow.
 */
export async function findBlacklistedEmailDomains(
  domains: string[]
): Promise<BlacklistedEmailDomain[]> {
  const blacklist = new Set(domains.map(domain => domain.toLowerCase().trim()).filter(Boolean));
  if (blacklist.size === 0) return [];

  const rows = await db
    .select({
      email_domain: kilocode_users.email_domain,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(kilocode_users)
    .where(
      and(
        isNull(kilocode_users.blocked_reason),
        blockableUserCondition(),
        isNotNull(kilocode_users.email_domain)
      )
    )
    .groupBy(kilocode_users.email_domain);

  return rows.flatMap(row =>
    row.email_domain !== null && emailDomainMatchesBlacklist(row.email_domain, blacklist)
      ? [{ email_domain: row.email_domain, count: row.count }]
      : []
  );
}

/**
 * Users who can be blocked by a domain backfill. Admins are excluded: a
 * blocked admin fails authorization before the admin check, so an automatic
 * domain block would lock the acting admin out with no way to undo it.
 */
export function blockableUserCondition(): SQL {
  return eq(kilocode_users.is_admin, false);
}

export type BlockBlacklistedDomainsBackfillResponse = {
  processed: number;
  remaining: boolean;
};

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;
const BLOCKED_REASON = 'domainblocked';

export async function backfillBlockBlacklistedDomainsBatch(params: {
  actorId: string;
  domains: string[];
}): Promise<BlockBlacklistedDomainsBackfillResponse> {
  if (params.domains.length === 0) {
    return { processed: 0, remaining: false };
  }

  const matchingDomains = (await findBlacklistedEmailDomains(params.domains)).map(
    row => row.email_domain
  );
  if (matchingDomains.length === 0) {
    return { processed: 0, remaining: false };
  }
  const condition = inArray(kilocode_users.email_domain, matchingDomains);
  let totalProcessed = 0;
  // Track whether we ever hit a short select, which is the only reliable
  // signal that the result set is exhausted. Basing `remaining` on
  // `totalProcessed` alone would falsely report "done" if concurrent writers
  // set `blocked_reason` on some of our selected rows (shrinking
  // `updated.length`) across every batch in this request.
  let reachedEnd = false;

  for (let i = 0; i < BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(and(isNull(kilocode_users.blocked_reason), blockableUserCondition(), condition))
      .limit(BATCH_SIZE);

    if (rows.length === 0) {
      reachedEnd = true;
      break;
    }

    // Re-check `blocked_reason IS NULL` in the update to cover a race where
    // another writer set it between the select and the update.
    const updated = await db
      .update(kilocode_users)
      .set({
        blocked_reason: BLOCKED_REASON,
        blocked_at: new Date().toISOString(),
        blocked_by_kilo_user_id: params.actorId,
        // Rotate per-row so each blocked user's existing API tokens are revoked
        // on every pepper-checking service.
        api_token_pepper: sql`gen_random_uuid()::text`,
      })
      .where(
        and(
          inArray(
            kilocode_users.id,
            rows.map(r => r.id)
          ),
          isNull(kilocode_users.blocked_reason),
          blockableUserCondition()
        )
      )
      .returning({ id: kilocode_users.id });

    totalProcessed += updated.length;

    if (rows.length < BATCH_SIZE) {
      reachedEnd = true;
      break;
    }
  }

  return { processed: totalProcessed, remaining: !reachedEnd };
}
