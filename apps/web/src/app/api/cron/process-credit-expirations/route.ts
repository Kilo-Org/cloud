import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { runCreditExpirationCron } from '@/lib/credit-expiration-cron';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export const maxDuration = 300;

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isCronAuthorizationValid(authHeader, CRON_SECRET)) {
    sentryLogger(
      'cron',
      'warning'
    )('SECURITY: Invalid credit expiration CRON authorization attempt');
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await runCreditExpirationCron();
  const failed = summary.failedUserIds.length + summary.failedOrganizationIds.length;
  sentryLogger('cron', failed === 0 ? 'info' : 'error')('Credit expiration cron completed', {
    dueUsers: summary.dueUsers,
    expiredUsers: summary.expiredUsers,
    failedUsers: summary.failedUserIds.length,
    dueOrganizations: summary.dueOrganizations,
    processedOrganizations: summary.processedOrganizations,
    failedOrganizations: summary.failedOrganizationIds.length,
  });

  return NextResponse.json(
    {
      success: failed === 0,
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: failed === 0 ? 200 : 500 }
  );
}
