import { NextResponse } from 'next/server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { getBlacklistedDomains } from '@kilocode/web-shared/lib/blacklist-domains-config';
import {
  BLACKLIST_STATS_ROW_LIMIT,
  computeBlacklistStats,
  countUsersByEmailHost,
} from '@/lib/abuse/blacklist-domain-stats';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  try {
    const blacklistedDomains = await getBlacklistedDomains();
    // The report is assembled from one grouped aggregate on the read replica.
    const emailHostCounts = await countUsersByEmailHost(readDb);

    return NextResponse.json(
      computeBlacklistStats(blacklistedDomains, emailHostCounts, BLACKLIST_STATS_ROW_LIMIT)
    );
  } catch (error) {
    console.error('Error fetching blacklisted domains:', error);
    return NextResponse.json({ error: 'Failed to fetch blacklisted domains' }, { status: 500 });
  }
}
