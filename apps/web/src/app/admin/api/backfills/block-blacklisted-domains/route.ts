import { NextResponse } from 'next/server';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBlacklistedDomains } from '@kilocode/web-shared/lib/blacklist-domains-config';
import {
  backfillBlockBlacklistedDomainsBatch,
  findBlacklistedEmailDomains,
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

  const matchingDomains = await findBlacklistedEmailDomains(domains);
  const unblocked = matchingDomains.reduce((sum, row) => sum + row.count, 0);

  return NextResponse.json({ unblocked });
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
