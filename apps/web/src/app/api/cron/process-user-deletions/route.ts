import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { runUserDeletionWorker } from '@/lib/user/deletion-queue/deletion-worker';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 60;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid CRON job authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const result = await runUserDeletionWorker();
  return NextResponse.json(
    {
      success: result.outcome === 'success',
      outcome: result.outcome,
      processed: result.processed,
    },
    { status: result.outcome === 'success' ? 200 : 500 }
  );
}
