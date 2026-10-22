import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { db } from '@kilocode/web-shared/lib/drizzle';
import { kilocode_users } from '@kilocode/db';
import { and, isNull, sql } from 'drizzle-orm';
import { getBlacklistedDomains } from '@kilocode/web-shared/lib/blacklist-domains-config';
import {
  backfillBlockBlacklistedDomainsBatch,
  blacklistedDomainCondition,
  type BlockBlacklistedDomainsBackfillResponse,
} from '@/lib/abuse/block-blacklisted-domains';

export type BlockBlacklistedDomainsCountsResponse = {
  unblocked: number;
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

export async function POST(): Promise<
  NextResponse<BlockBlacklistedDomainsBackfillResponse | { error: string }>
> {
  const { user, authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) return authFailedResponse;

  const domains = await getBlacklistedDomains();
  return NextResponse.json(
    await backfillBlockBlacklistedDomainsBatch({ actorId: user.id, domains })
  );
}
