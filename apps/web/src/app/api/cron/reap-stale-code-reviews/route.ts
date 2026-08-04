import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { reapStaleCodeReviews } from '@/lib/code-reviews/reap-stale-reviews';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * A batch walks up to REAP_DEFAULT_BATCH_SIZE rows sequentially, each with a
 * potential provider call. Backlog rows in particular reference suspended or
 * uninstalled integrations whose calls fail slowly, so the default budget is
 * not enough. Matches the other batch crons in this directory.
 */
export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const expectedAuth = `Bearer ${CRON_SECRET}`;
  if (authHeader !== expectedAuth) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid CRON job authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await reapStaleCodeReviews();

  return NextResponse.json(
    {
      success: true,
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
