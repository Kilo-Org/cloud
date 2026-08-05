import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { syncNotificationAudiencesToRedis } from '@/lib/notifications/notification-audience-cache';

// Writing one Redis entry per user can take a while for large result sets;
// allow more than the default serverless budget.
export const maxDuration = 300;

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * Vercel Cron Job: Sync notification audiences
 *
 * Runs daily, materializing analytics audiences from PostHog and Snowflake into
 * small per-user Redis entries consumed by the notifications endpoint.
 */
export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const result = await syncNotificationAudiencesToRedis();
    console.info('[cron/sync-notification-audiences] synced', result);

    return NextResponse.json({
      success: true,
      ...result,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[cron/sync-notification-audiences]', error);
    captureException(error, {
      tags: { endpoint: 'cron/sync-notification-audiences' },
    });

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to sync notification audiences',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
