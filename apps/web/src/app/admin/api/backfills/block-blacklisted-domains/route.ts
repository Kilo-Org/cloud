import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@/lib/user.server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, count, isNull, or, sql } from 'drizzle-orm';
import { getEnvVariable } from '@/lib/dotenvx';

const blacklistDomainsEnv = getEnvVariable('BLACKLIST_DOMAINS');
const BLACKLIST_DOMAINS = blacklistDomainsEnv
  ? blacklistDomainsEnv.split('|').map((domain: string) => domain.trim())
  : [];

function blacklistedDomainConditions() {
  const conditions = BLACKLIST_DOMAINS.flatMap(domain => [
    sql`lower(${kilocode_users.google_user_email}) LIKE ${`%@${domain.toLowerCase()}`}`,
    sql`lower(${kilocode_users.google_user_email}) LIKE ${`%.${domain.toLowerCase()}`}`,
  ]);
  return or(...conditions);
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

  if (BLACKLIST_DOMAINS.length === 0) {
    return NextResponse.json({ unblocked: 0 });
  }

  const [result] = await db
    .select({ count: count() })
    .from(kilocode_users)
    .where(and(isNull(kilocode_users.blocked_reason), blacklistedDomainConditions()));

  return NextResponse.json({ unblocked: result?.count ?? 0 });
}

const BATCH_SIZE = 1000;
const BATCHES_PER_REQUEST = 50;
const BLOCKED_REASON = 'domainblocked';

export async function POST(): Promise<
  NextResponse<BlockBlacklistedDomainsBackfillResponse | { error: string }>
> {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  if (BLACKLIST_DOMAINS.length === 0) {
    return NextResponse.json({ processed: 0, remaining: false });
  }

  let totalProcessed = 0;

  for (let i = 0; i < BATCHES_PER_REQUEST; i++) {
    const rows = await db
      .select({ id: kilocode_users.id })
      .from(kilocode_users)
      .where(and(isNull(kilocode_users.blocked_reason), blacklistedDomainConditions()))
      .limit(BATCH_SIZE);

    if (rows.length === 0) break;

    await db
      .update(kilocode_users)
      .set({ blocked_reason: BLOCKED_REASON })
      .where(
        and(
          sql`${kilocode_users.id} IN (${sql.join(
            rows.map(r => sql`${r.id}`),
            sql`, `
          )})`,
          isNull(kilocode_users.blocked_reason)
        )
      );

    totalProcessed += rows.length;

    if (rows.length < BATCH_SIZE) break;
  }

  return NextResponse.json({
    processed: totalProcessed,
    remaining: totalProcessed === BATCH_SIZE * BATCHES_PER_REQUEST,
  });
}
