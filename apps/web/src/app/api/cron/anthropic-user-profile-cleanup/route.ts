import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { runAnthropicUserProfileCleanup } from '@/lib/anthropic-user-profiles/cleanup';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 300;

export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const counts = await runAnthropicUserProfileCleanup();
    console.info('[cron/anthropic-user-profile-cleanup] completed', counts);

    return NextResponse.json({ success: true, counts, timestamp: new Date().toISOString() });
  } catch (error) {
    console.error('[cron/anthropic-user-profile-cleanup] failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    captureException(error, {
      tags: { endpoint: 'cron/anthropic-user-profile-cleanup' },
    });

    return NextResponse.json(
      { success: false, error: 'Failed to clean up Anthropic user profiles' },
      { status: 500 }
    );
  }
}
