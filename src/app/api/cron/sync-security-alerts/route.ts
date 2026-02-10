import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { CRON_SECRET, SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL } from '@/lib/config.server';
import { runFullSync } from '@/lib/security-agent/services/sync-service';
import { sentryLogger } from '@/lib/utils.server';

const log = sentryLogger('security-agent:cron-sync', 'info');
const cronWarn = sentryLogger('cron', 'warning');
const logError = sentryLogger('security-agent:cron-sync', 'error');

/**
 * Vercel Cron Job: Sync Security Alerts
 *
 * This endpoint runs periodically to sync Dependabot alerts from GitHub
 * for all organizations/users with security reviews enabled.
 *
 * Schedule: Every 6 hours
 */
export async function GET(request: NextRequest) {
  try {
    const authHeader = request.headers.get('authorization');
    if (!CRON_SECRET || authHeader !== `Bearer ${CRON_SECRET}`) {
      cronWarn(
        'SECURITY: Invalid CRON job authorization attempt: ' +
          (authHeader ? 'Invalid authorization header' : 'Missing authorization header')
      );
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    log('Starting security alerts sync...');
    const startTime = Date.now();

    const result = await runFullSync();

    const duration = Date.now() - startTime;
    const summary = {
      success: true,
      duration: `${duration}ms`,
      totalSynced: result.totalSynced,
      totalErrors: result.totalErrors,
      configsProcessed: result.configsProcessed,
      timestamp: new Date().toISOString(),
    };

    log('Sync completed', summary);

    // Send heartbeat to BetterStack on success
    if (SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL) {
      await fetch(SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }

    return NextResponse.json(summary);
  } catch (error) {
    logError('Error syncing security alerts', { error });
    captureException(error, {
      tags: { endpoint: 'cron/sync-security-alerts' },
      extra: {
        action: 'syncing_security_alerts',
      },
    });

    // Send failure heartbeat to BetterStack
    if (SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL) {
      await fetch(`${SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL}/fail`, {
        signal: AbortSignal.timeout(5000),
      }).catch(() => {});
    }

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to sync security alerts',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  }
}
