import { NextResponse } from 'next/server';

import { db } from '@kilocode/web-shared/lib/drizzle';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { sentryLogger } from '@kilocode/web-shared/lib/utils.server';
import { runCodingPlanBillingLifecycleCron } from '@/lib/coding-plans/billing-lifecycle-cron';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  const expectedAuth = `Bearer ${CRON_SECRET}`;
  if (authHeader !== expectedAuth) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid coding-plans-billing CRON authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await runCodingPlanBillingLifecycleCron(db);

  return NextResponse.json(
    {
      success: true,
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
