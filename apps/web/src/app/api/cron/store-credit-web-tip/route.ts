import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { dispatchStoreCreditWebTipEmails } from '@/lib/credits/store-credit-email';

export const maxDuration = 300;

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

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

  const summary = await dispatchStoreCreditWebTipEmails();
  return NextResponse.json({ success: true, summary, timestamp: new Date().toISOString() });
}
