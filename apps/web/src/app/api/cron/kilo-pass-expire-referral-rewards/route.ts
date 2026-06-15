import { timingSafeEqual } from 'node:crypto';
import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { expirePendingKiloPassReferralRewards } from '@/lib/impact/kilo-pass-referrals';
import { sentryLogger } from '@/lib/utils.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

function isExpectedCronAuthorization(authHeader: string | null): boolean {
  if (!authHeader) return false;

  const authHeaderBuffer = Buffer.from(authHeader);
  const expectedAuthBuffer = Buffer.from(`Bearer ${CRON_SECRET}`);
  if (authHeaderBuffer.length !== expectedAuthBuffer.length) return false;

  return timingSafeEqual(authHeaderBuffer, expectedAuthBuffer);
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (!isExpectedCronAuthorization(authHeader)) {
    sentryLogger(
      'cron',
      'warning'
    )(
      'SECURITY: Invalid CRON job authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const summary = await expirePendingKiloPassReferralRewards();

  return NextResponse.json(
    {
      success: true,
      summary,
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
