import { NextResponse } from 'next/server';
import { CRON_SECRET } from '@kilocode/web-shared/lib/config.server';
import { isCronAuthorizationValid } from '@/lib/cron-auth';
import {
  collectCodeReviewOpenStock,
  collectCodeReviewOutcome,
} from '@/lib/code-reviews/telemetry/review-health-aggregate';

export async function GET(request: Request) {
  if (
    !CRON_SECRET ||
    !isCronAuthorizationValid(request.headers.get('authorization'), CRON_SECRET)
  ) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const outcomeStatus = await collectCodeReviewOutcome();
  const openStockStatus = await collectCodeReviewOpenStock();

  return NextResponse.json({
    collectionStatus:
      outcomeStatus === 'complete' && openStockStatus === 'complete' ? 'complete' : 'failed',
  });
}
