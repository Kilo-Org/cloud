import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { kilocode_users } from '@kilocode/db/schema';
import { sql, count, or } from 'drizzle-orm';
import { getUserFromAuth } from '@/lib/user.server';
import { getBlacklistedDomains } from '@/lib/blacklist-domains-config';

export async function GET() {
  const { authFailedResponse } = await getUserFromAuth({ adminOnly: true });
  if (authFailedResponse) {
    return authFailedResponse;
  }

  try {
    const BLACKLIST_DOMAINS = await getBlacklistedDomains();

    // Get counts for each blacklisted domain
    const domainCounts = await Promise.all(
      BLACKLIST_DOMAINS.map(async domain => {
        // Build conditions for both @domain and .domain patterns
        const conditions = or(
          sql`lower(${kilocode_users.google_user_email}) LIKE ${`%@${domain.toLowerCase()}`}`,
          sql`lower(${kilocode_users.google_user_email}) LIKE ${`%.${domain.toLowerCase()}`}`
        );

        const result = await db.select({ count: count() }).from(kilocode_users).where(conditions);

        return {
          domain,
          blockedCount: result[0]?.count || 0,
        };
      })
    );

    // Sort by blocked count descending
    domainCounts.sort((a, b) => b.blockedCount - a.blockedCount);

    return NextResponse.json({
      domains: domainCounts,
      totalDomains: BLACKLIST_DOMAINS.length,
      totalBlockedUsers: domainCounts.reduce((sum, d) => sum + Number(d.blockedCount), 0),
    });
  } catch (error) {
    console.error('Error fetching blacklisted domains:', error);
    return NextResponse.json({ error: 'Failed to fetch blacklisted domains' }, { status: 500 });
  }
}
