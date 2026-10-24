import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, eq, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';

/**
 * Builds a WHERE condition that matches users whose `email_domain` is on the
 * blacklist. Mirrors the suffix semantics of `isDomainOnBlacklist` — an entry
 * matches when the stored domain equals it or is a strict subdomain of it.
 *
 * Operates on the indexed `email_domain` column rather than a LIKE scan of
 * `google_user_email`, so counts and updates stay fast on a large users table.
 *
 * Both domain lists are bound as single array parameters. An imported list can
 * hold tens of thousands of entries, which would otherwise exceed PostgreSQL's
 * 65,535-bind-parameter limit.
 */
export function blacklistedDomainCondition(domains: string[]): SQL {
  const normalized = [...new Set(domains.map(d => d.toLowerCase().trim()).filter(Boolean))];
  if (normalized.length === 0) {
    // Always-false guard so the caller doesn't have to special-case an empty
    // blacklist. `or()` with no args returns undefined, which would accidentally
    // drop the condition entirely.
    return sql`false`;
  }
  const subdomainPatterns = normalized.map(d => `%.${d}`);
  const combined = or(
    sql`${kilocode_users.email_domain} = ANY(${sql.param(normalized)}::text[])`,
    sql`${kilocode_users.email_domain} LIKE ANY(${sql.param(subdomainPatterns)}::text[])`
  );
  return combined ?? sql`false`;
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

  const condition = blacklistedDomainCondition(params.domains);
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
