import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { getBlacklistedDomains } from '@/lib/blacklist-domains-config';

/**
 * Builds a WHERE condition that matches users whose `email_domain` is on the
 * blacklist. Mirrors the suffix semantics of `isDomainOnBlacklist` — an entry
 * matches when the stored domain equals it or is a strict subdomain of it.
 *
 * Operates on the indexed `email_domain` column rather than a LIKE scan of
 * `google_user_email`, so counts and updates stay fast on a large users table.
 */
export function blacklistedDomainCondition(domains: string[]): SQL {
  const normalized = domains.map(d => d.toLowerCase().trim()).filter(Boolean);
  if (normalized.length === 0) {
    // Always-false guard so the caller doesn't have to special-case an empty
    // blacklist. `or()` with no args returns undefined, which would accidentally
    // drop the condition entirely.
    return sql`false`;
  }
  const conditions: SQL[] = [
    inArray(kilocode_users.email_domain, normalized),
    ...normalized.map(d => sql`${kilocode_users.email_domain} LIKE ${`%.${d}`}`),
  ];
  const combined = or(...conditions);
  return combined ?? sql`false`;
}

export type BlockBlacklistedDomainsCountsResponse = {
  unblocked: number;
};

export type BlockBlacklistedDomainsBackfillResponse = {
  processed: number;
  remaining: boolean;
};

export async function GET(): Promise<
  NextResponse<BlockBlacklistedDomainsCountsResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const domains = await getBlacklistedDomains();
  if (domains.length === 0) {
    return NextResponse.json({ unblocked: 0 });
  }

  const [result] = await db
    .select({ count: sql<number>`count(*)`.mapWith(Number) })
    .from(kilocode_users)
    .where(and(isNull(kilocode_users.blocked_reason), blacklistedDomainCondition(domains)));

  return NextResponse.json({ unblocked: result?.count ?? 0 });
}

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;
const BLOCKED_REASON = 'domainblocked';

export async function POST(): Promise<
  NextResponse<BlockBlacklistedDomainsBackfillResponse | { error: string }>
> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const domains = await getBlacklistedDomains();
  if (domains.length === 0) {
    return NextResponse.json({ processed: 0, remaining: false });
  }

  const condition = blacklistedDomainCondition(domains);
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
      .where(and(isNull(kilocode_users.blocked_reason), condition))
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
        blocked_by_kilo_user_id: user.id,
      })
      .where(
        and(
          inArray(
            kilocode_users.id,
            rows.map(r => r.id)
          ),
          isNull(kilocode_users.blocked_reason)
        )
      )
      .returning({ id: kilocode_users.id });

    totalProcessed += updated.length;

    if (rows.length < BATCH_SIZE) {
      reachedEnd = true;
      break;
    }
  }

  return NextResponse.json({
    processed: totalProcessed,
    remaining: !reachedEnd,
  });
}
