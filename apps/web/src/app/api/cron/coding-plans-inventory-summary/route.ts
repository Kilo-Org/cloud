import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { sendCodingPlanInventorySlackSummary } from '@/lib/coding-plans/inventory-slack-summary';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const totals = await sendCodingPlanInventorySlackSummary();
    console.info('[cron/coding-plans-inventory-summary] sent', totals);

    return NextResponse.json({
      success: true,
      totals,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[cron/coding-plans-inventory-summary] failed', {
      errorName: error instanceof Error ? error.name : 'UnknownError',
    });
    captureException(error, {
      tags: { endpoint: 'cron/coding-plans-inventory-summary' },
    });

    return NextResponse.json(
      { success: false, error: 'Failed to send Coding Plans inventory summary' },
      { status: 500 }
    );
  }
}
