import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { publishEnkryptModelStats } from '@/lib/model-stats/enkrypt-publication';
import { getModelStatsSnapshot } from '@/lib/model-stats/model-stats-cache';

export const revalidate = 0;
export const dynamic = 'force-dynamic';

const headers = { 'Cache-Control': 'no-store' };

/**
 * GET /api/models/stats/[slug]
 * Returns model statistics for a specific model by slug
 */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  try {
    const { slug } = await params;

    const snapshot = await getModelStatsSnapshot();
    const entry = snapshot.entries.find(({ stat }) => stat.slug === slug);

    if (!entry) {
      return NextResponse.json(
        { error: `Model with slug "${slug}" not found` },
        { status: 404, headers }
      );
    }

    return NextResponse.json(publishEnkryptModelStats(entry.stat, snapshot, entry.verification), {
      headers,
    });
  } catch (error) {
    console.error('Error fetching model stat by slug:', error);
    captureException(error, {
      tags: { endpoint: 'api/models/stats/[slug]' },
    });

    return NextResponse.json(
      { error: 'Failed to fetch model statistics' },
      { status: 500, headers }
    );
  }
}
