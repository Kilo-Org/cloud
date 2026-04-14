import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';

import { CRON_SECRET } from '@/lib/config.server';
import {
  syncContributorChampionData,
  processAutoTierUpgrades,
  refreshContributorChampionCredits,
} from '@/lib/contributor-champions/service';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

export async function GET(request: Request) {
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const startedAt = Date.now();

  // Run each step independently so a failure in one doesn't block the others
  const errors: Array<{ step: string; message: string }> = [];

  let syncResult = null;
  try {
    syncResult = await syncContributorChampionData();
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'cron/contributor-champions-sync', step: 'sync' },
    });
    errors.push({ step: 'sync', message: error instanceof Error ? error.message : 'Unknown' });
  }

  let upgradeResult = null;
  try {
    upgradeResult = await processAutoTierUpgrades();
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'cron/contributor-champions-sync', step: 'upgrade' },
    });
    errors.push({ step: 'upgrade', message: error instanceof Error ? error.message : 'Unknown' });
  }

  let creditRefreshResult = null;
  try {
    creditRefreshResult = await refreshContributorChampionCredits();
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'cron/contributor-champions-sync', step: 'credits' },
    });
    errors.push({ step: 'credits', message: error instanceof Error ? error.message : 'Unknown' });
  }

  const durationMs = Date.now() - startedAt;

  return NextResponse.json(
    {
      success: errors.length === 0,
      duration: `${durationMs}ms`,
      syncResult,
      upgradeResult,
      creditRefreshResult,
      errors: errors.length > 0 ? errors : undefined,
      timestamp: new Date().toISOString(),
    },
    { status: errors.length > 0 ? 207 : 200 }
  );
}
