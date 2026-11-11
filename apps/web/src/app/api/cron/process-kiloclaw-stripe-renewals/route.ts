import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import { runStripeRenewalBatches } from '@/lib/kiloclaw/admin-stripe-renewal-batch';

if (!CRON_SECRET) throw new Error('CRON_SECRET is not configured in environment variables');

export const maxDuration = 60;

export async function GET(request: Request) {
  if (!isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  return NextResponse.json(await runStripeRenewalBatches());
}
