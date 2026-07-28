import { NextResponse } from 'next/server';
import { captureException } from '@sentry/nextjs';
import {
  buildScheduledJobFailureEvent,
  buildScheduledJobSuccessEvent,
  createScheduledJobRun,
  emitScheduledJobEvent,
} from '@kilocode/worker-utils/scheduled-job-observability';
import { cleanupStaleAnalyses } from '@/lib/security-agent/db/security-analysis';
import { sentryLogger } from '@/lib/utils.server';
import { CRON_SECRET } from '@/lib/config.server';

if (!CRON_SECRET) {
  throw new Error('CRON_SECRET is not configured in environment variables');
}

const log = sentryLogger('security-agent:cron-cleanup', 'info');
const warn = sentryLogger('security-agent:cron-cleanup', 'warning');
const cronWarn = sentryLogger('cron', 'warning');

/** Threshold for alerting on abnormally high stale analysis counts */
const STALE_ANOMALY_THRESHOLD = 10;

/**
 * Cron job endpoint to cleanup stale security analyses
 *
 * Analyses that have been "running" for more than 30 minutes are considered stale
 * and are marked as failed. This handles cases where:
 * - The serverless function timed out
 * - The cloud agent session was interrupted
 * - Network issues prevented completion
 *
 * Recommended schedule: Every 15 minutes
 */
export async function GET(request: Request) {
  // Verify authorization
  const authHeader = request.headers.get('authorization');

  // Check if authorization header matches the secret
  // Vercel sends: Authorization: Bearer <CRON_SECRET>
  const expectedAuth = `Bearer ${CRON_SECRET}`;
  if (authHeader !== expectedAuth) {
    cronWarn(
      'SECURITY: Invalid CRON job authorization attempt: ' +
        (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
    );
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const run = createScheduledJobRun({
    jobName: 'web.cleanup_stale_analyses',
    environment: process.env.VERCEL_ENV ?? process.env.NODE_ENV,
  });

  try {
    // Execute cleanup - mark analyses running for more than 30 minutes as failed
    const cleanedCount = await cleanupStaleAnalyses(30);

    if (cleanedCount > 0) {
      log(`Cleaned up ${cleanedCount} stale security analyses`);
    }

    // Alert if abnormally high number of stale analyses indicates a systemic issue
    if (cleanedCount > STALE_ANOMALY_THRESHOLD) {
      warn(
        `Abnormally high stale analysis count: ${cleanedCount} (threshold: ${STALE_ANOMALY_THRESHOLD}). This may indicate a systemic problem with analysis completion.`,
        { cleanedCount, threshold: STALE_ANOMALY_THRESHOLD }
      );
    }

    emitScheduledJobEvent(
      buildScheduledJobSuccessEvent(run, {
        cleaned_count: cleanedCount,
        anomaly_threshold: STALE_ANOMALY_THRESHOLD,
        anomaly_detected: cleanedCount > STALE_ANOMALY_THRESHOLD,
      })
    );

    return NextResponse.json({
      success: true,
      cleanedCount,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'cron/cleanup-stale-analyses' },
    });

    emitScheduledJobEvent(buildScheduledJobFailureEvent(run, error));

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to cleanup stale analyses',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
