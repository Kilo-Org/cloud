import { NextResponse } from 'next/server';

import { db } from '@/lib/drizzle';
import { CRON_SECRET } from '@/lib/config.server';
import { sentryLogger } from '@/lib/utils.server';
import { runKiloPassYearlyMonthlyBaseCron } from '@/lib/kilo-pass/yearly-monthly-base-cron';

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
      'SECURITY: Invalid CRON job authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await runKiloPassYearlyMonthlyBaseCron(db);

  return NextResponse.json(
    {
      success: true,
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
