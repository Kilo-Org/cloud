import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sendUserDeletionAttentionSlackSummary } from '@/lib/user/deletion-queue/deletion-attention-slack-summary';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const counts = await sendUserDeletionAttentionSlackSummary();
    console.info('[cron/user-deletion-attention-summary] completed', counts);

    return NextResponse.json({ success: true, counts, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/user-deletion-attention-summary] failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    captureException(error, {
      tags: { endpoint: 'cron/user-deletion-attention-summary' },
    });

    return NextResponse.json(
      { success: false, error: 'Failed to send user deletion attention summary' },
      { status: 500 }
    );
  }
}
