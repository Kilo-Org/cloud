import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import { eq, desc } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';
import { publishEnkryptModelStats } from '@/lib/model-stats/enkrypt-publication';
import { getEnkryptVerifications } from '@/lib/model-stats/enkrypt-verifications';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

/**
 * GET /api/models/stats
 * Returns all active model statistics
 */
export async function GET(_request: NextRequest) {
  try {
    const stats = await db
      .select()
      .from(modelStats)
      .where(eq(modelStats.isActive, true))
      .orderBy(desc(modelStats.codingIndex));

    const verifications = await getEnkryptVerifications();
    return NextResponse.json(
      stats.map(stat => publishEnkryptModelStats(stat, verifications[stat.openrouterId])),
      { headers }
    );
  } catch (error) {
    console.error('Error fetching model stats:', error);
    captureException(error, {
      tags: { endpoint: 'api/models/stats' },
    });

    return NextResponse.json(
      { error: 'Failed to fetch model statistics' },
      { status: 500, headers }
    );
  }
}
