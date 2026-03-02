import type { NextRequest } from 'next/server';
import { NextResponse } from 'next/server';
import { db } from '@/lib/drizzle';
import { modelStats } from '@kilocode/db/schema';
import { eq, desc } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

export const revalidate = 3600; // 1 hour cache

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

    return NextResponse.json(stats);
  } catch (error) {
    console.error('Error fetching model stats:', error);
    captureException(error, {
      tags: { endpoint: 'api/models/stats' },
    });

    return NextResponse.json({ error: 'Failed to fetch model statistics' }, { status: 500 });
  }
}
