import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { runExpireCreditsCron } from '@/lib/credit-expiration-cron';
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

  const summary = await runExpireCreditsCron();
  const failed = summary.usersFailed > 0 || summary.organizationsFailed > 0;
  return NextResponse.json(
    {
      success: !failed,
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: failed ? 500 : 200 }
  );
}
