import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { publishEnkryptModelStats } from '@/lib/model-stats/enkrypt-publication';
import { getModelStatsSnapshot } from '@/lib/model-stats/model-stats-cache';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

/**
 * GET /api/models/stats
 * Returns all active model statistics
 */
export async function GET(_request: NextRequest) {
  try {
    const snapshot = await getModelStatsSnapshot();
    return NextResponse.json(
      snapshot.entries
        .filter(({ stat }) => stat.isActive === true)
        .map(({ stat, verification }) => publishEnkryptModelStats(stat, snapshot, verification)),
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
