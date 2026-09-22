import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sendMiniMaxTokenHealthSlackSummary } from '@/lib/coding-plans/minimax-token-health';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

// Fans out to every assigned MiniMax key at bounded concurrency
// (MINIMAX_TOKEN_HEALTH_CONCURRENCY); size the duration for that fan-out
// rather than the platform default, matching usage-daily-rollup-repairs.
export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const totals = await sendMiniMaxTokenHealthSlackSummary();
    console.info('[cron/minimax-token-health] sent', totals);

    return NextResponse.json({
      success: true,
      totals,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[cron/minimax-token-health] failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    captureException(error, {
      tags: { endpoint: 'cron/minimax-token-health' },
    });

    return NextResponse.json(
      { success: false, error: 'Failed to send MiniMax token health summary' },
      { status: 500 }
    );
  }
}
