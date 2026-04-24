import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { dispatchQueuedAffiliateEvents } from '@/lib/affiliate-events';
import { dispatchQueuedImpactAdvocateRegistrationAttempts } from '@/lib/impact-referral';
import {
  dispatchQueuedImpactConversionReports,
  processQueuedKiloClawReferralRewards,
} from '@/lib/kiloclaw-referrals';
import { sentryLogger } from '@/lib/utils.server';

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

  const [
    affiliateSummary,
    impactAdvocateRegistrationSummary,
    impactConversionSummary,
    referralRewardSummary,
  ] = await Promise.all([
    dispatchQueuedAffiliateEvents(),
    dispatchQueuedImpactAdvocateRegistrationAttempts(),
    dispatchQueuedImpactConversionReports(),
    processQueuedKiloClawReferralRewards(),
  ]);

  return NextResponse.json(
    {
      success: true,
      summary: {
        affiliateEvents: affiliateSummary,
        impactAdvocateRegistrations: impactAdvocateRegistrationSummary,
        impactConversionReports: impactConversionSummary,
        referralRewards: referralRewardSummary,
      },
      timestamp: new Date().toISOString(),
    },
    { status: 200 }
  );
}
