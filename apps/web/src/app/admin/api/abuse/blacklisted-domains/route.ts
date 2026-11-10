import { NextResponse } from 'next/server';
import { readDb } from '@kilocode/web-shared/lib/drizzle';
import { getUserFromAuth } from '@kilocode/web-shared/lib/user/server';
import { listBlacklistedDomains } from '@kilocode/web-shared/lib/blacklist-domains-config';
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
    // The report is assembled from the list and one grouped aggregate on the read replica.
    const [blacklistedDomains, emailHostCounts] = await Promise.all([
      listBlacklistedDomains(readDb),
      countUsersByEmailHost(readDb),
    ]);

    return NextResponse.json(
      computeBlacklistStats(blacklistedDomains, emailHostCounts, BLACKLIST_STATS_ROW_LIMIT)
    );
  } catch (error) {
    console.error('Error fetching blacklisted domains:', error);
    return NextResponse.json({ error: 'Failed to fetch blacklisted domains' }, { status: 500 });
  }
}
