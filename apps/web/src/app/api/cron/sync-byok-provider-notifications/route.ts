import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';

import { CRON_SECRET } from '@/lib/config.server';
import { syncByokProviderNotificationsToRedis } from '@/lib/notifications/byok-provider-cache';

// Writing one Redis entry per user can take a while for large result sets;
// allow more than the default serverless budget.
export const maxDuration = 300;

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

function isExpectedCronAuthorization(authHeader: string | null): boolean {
  if (!authHeader) return false;

  const authHeaderBuffer = Buffer.from(authHeader);
  const expectedAuthBuffer = Buffer.from(`Bearer ${CRON_SECRET}`);
  if (authHeaderBuffer.length !== expectedAuthBuffer.length) return false;

  return timingSafeEqual(authHeaderBuffer, expectedAuthBuffer);
}

/**
 * Vercel Cron Job: Sync BYOK provider notifications
 *
 * Runs daily, queries PostHog once for which users have used which BYOK
 * providers, and writes one Redis entry per user (array of provider ids) with a
 * 7-day TTL. The notifications endpoint then reads only the current user's
 * entry instead of fetching and scanning the full dataset on every poll.
 */
export async function GET(request: Request) {
  if (!isExpectedCronAuthorization(request.headers.get('authorization'))) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await syncByokProviderNotificationsToRedis();
    console.info('[cron/sync-byok-provider-notifications] synced', result);

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[cron/sync-byok-provider-notifications]', error);
    captureException(error, {
      tags: { endpoint: 'cron/sync-byok-provider-notifications' },
    });

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to sync BYOK provider notifications',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
