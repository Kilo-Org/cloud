import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { captureException } from '@sentry/nextjs';
import { CRON_SECRET, SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL } from '@/lib/config.server';
import { runFullSync } from '@/lib/security-agent/services/sync-service';
import { shutdownPosthog } from '@/lib/posthog';
import { sentryLogger } from '@/lib/utils.server';

export const maxDuration = 800;

const log = sentryLogger('security-agent:cron-sync', 'info');
const cronWarn = sentryLogger('cron', 'warning');
const logError = sentryLogger('security-agent:cron-sync', 'error');

type HeartbeatType = 'success' | 'failure';

async function shutdownPosthogWithTimeout(): Promise<void> {
  const timeoutMs = 3000;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;

  try {
    await Promise.race([
      shutdownPosthog(),
      new Promise<never>((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`PostHog shutdown timed out after ${timeoutMs}ms`));
        }, timeoutMs);
      }),
    ]);
  } catch (error) {
    cronWarn('SECURITY: PostHog shutdown failed in cron sync handler', {
      error: error instanceof Error ? error.message : String(error),
    });
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

async function sendBetterStackHeartbeat(params: {
  heartbeatUrl: string | undefined;
  heartbeatType: HeartbeatType;
  context: Record<string, number | string>;
}): Promise<void> {
  const { heartbeatUrl, heartbeatType, context } = params;

  if (!heartbeatUrl) {
    cronWarn('SECURITY: BetterStack heartbeat URL is not configured', {
      heartbeatType,
      ...context,
    });
    return;
  }

  const requestStart = performance.now();
  try {
    const response = await fetch(heartbeatUrl, {
      signal: AbortSignal.timeout(5000),
    });
    const durationMs = Math.round(performance.now() - requestStart);

    if (!response.ok) {
      cronWarn('SECURITY: BetterStack heartbeat returned non-OK response', {
        heartbeatType,
        heartbeatStatus: response.status,
        heartbeatStatusText: response.statusText,
        heartbeatDurationMs: durationMs,
        heartbeatConfigured: true,
        ...context,
      });
      return;
    }

    log('BetterStack heartbeat sent', {
      heartbeatType,
      heartbeatStatus: response.status,
      heartbeatDurationMs: durationMs,
      ...context,
    });
  } catch (error) {
    const durationMs = Math.round(performance.now() - requestStart);
    cronWarn('SECURITY: BetterStack heartbeat request failed', {
      heartbeatType,
      heartbeatDurationMs: durationMs,
      heartbeatConfigured: true,
      error: error instanceof Error ? error.message : String(error),
      ...context,
    });
  }
}

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

    await sendBetterStackHeartbeat({
      heartbeatUrl: SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL,
      heartbeatType: 'success',
      context: {
        totalSynced: result.totalSynced,
        totalErrors: result.totalErrors,
        configsProcessed: result.configsProcessed,
      },
    });

    return NextResponse.json(summary);
  } catch (error) {
    const errorName = error instanceof Error ? error.name : 'UnknownError';
    const errorMessage = error instanceof Error ? error.message : String(error);
    const errorStack = error instanceof Error ? error.stack : undefined;

    logError('Error syncing security alerts', {
      errorName,
      errorMessage,
      errorStack,
    });
    captureException(error, {
      tags: { endpoint: 'cron/sync-security-alerts' },
      extra: {
        action: 'syncing_security_alerts',
      },
    });

    await sendBetterStackHeartbeat({
      heartbeatUrl: SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL
        ? `${SECURITY_SYNC_BETTERSTACK_HEARTBEAT_URL}/fail`
        : undefined,
      heartbeatType: 'failure',
      context: {
        errorType: errorName,
      },
    });

    return NextResponse.json(
      {
        success: false,
        error: 'Failed to sync security alerts',
        message: error instanceof Error ? error.message : 'Unknown error',
      },
      { status: 500 }
    );
  } finally {
    try {
      await shutdownPosthogWithTimeout();
    } catch (error) {
      cronWarn('SECURITY: Unexpected failure during PostHog shutdown cleanup', {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
