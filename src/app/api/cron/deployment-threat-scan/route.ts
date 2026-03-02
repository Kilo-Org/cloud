import { NextResponse } from 'next/server';

import { CRON_SECRET } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { sentryLogger } from '@/lib/utils.server';
import { deployments } from '@kilocode/db/schema';
import { eq, asc } from 'drizzle-orm';
import { scanDeployment } from '@/lib/webrisk';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

/**
 * Vercel Cron Job: Deployment Threat Scan
 *
 * Schedule: Every 5 minutes
 * using Google Web Risk API.
 *
 * Schedule: Every minute
 */
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

  console.log('[deployment-threat-scan] Starting threat scan cron...');
  const startTime = Date.now();

  // Get deployments pending scan, oldest first (by last_deployed_at)
  // Uses partial index idx_deployments_threat_status_pending for efficient queries
  const pendingDeployments = await db.query.deployments.findMany({
    where: eq(deployments.threat_status, 'pending_scan'),
    orderBy: asc(deployments.last_deployed_at),
    limit: 25,
  });

  let scanned = 0;
  let threats = 0;
  const errors: string[] = [];

  const BATCH_SIZE = 5;
  for (let i = 0; i < pendingDeployments.length; i += BATCH_SIZE) {
    const batch = pendingDeployments.slice(i, i + BATCH_SIZE);
    const results = await Promise.allSettled(batch.map(deployment => scanDeployment(deployment)));

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      const deployment = batch[j];
      if (result.status === 'fulfilled') {
        scanned++;
        if (result.value?.isThreat) threats++;
      } else {
        const errorMsg = result.reason instanceof Error ? result.reason.message : 'Unknown error';
        sentryLogger('cron', 'error')(`Scan failed for deployment ${deployment.id}: ${errorMsg}`, {
          error: result.reason,
        });
        errors.push(`${deployment.id}: ${errorMsg}`);
      }
    }
    // Small delay between batches to respect rate limits
    if (i + BATCH_SIZE < pendingDeployments.length) {
      await new Promise(r => setTimeout(r, 100));
    }
  }

  const duration = Date.now() - startTime;
  const summary = {
    duration: `${duration}ms`,
    scanned,
    threats,
    pending: pendingDeployments.length,
    errors: errors.length > 0 ? errors : undefined,
  };

  console.log('[deployment-threat-scan] Scan completed:', summary);

  return NextResponse.json({
    success: true,
    summary,
    timestamp: new Date().toISOString(),
  });
}
