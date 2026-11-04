import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { CLOUD_AGENT_DISPATCH_HEALTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import { evaluateDispatchHealth } from '@/lib/cloud-agent/dispatch-health/detector';
import {
  buildCompletedHealthyResponse,
  buildCompletedUnhealthyResponse,
  buildFailedOpenHealthyResponse,
  type DispatchHealthResponse,
} from '@/lib/cloud-agent/dispatch-health/health-response';

const DETECTOR_STATEMENT_TIMEOUT_MS = 10_000;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

type UnauthorizedResponse = { healthy: false };

export async function GET(
  request: Request
): Promise<NextResponse<DispatchHealthResponse | UnauthorizedResponse>> {
  const token = extractBearerToken(request.headers.get('authorization'));

  if (
    !CLOUD_AGENT_DISPATCH_HEALTH_SECRET ||
    !token ||
    !timingSafeEqual(token, CLOUD_AGENT_DISPATCH_HEALTH_SECRET)
  ) {
    return NextResponse.json({ healthy: false }, { status: 401, headers: NO_STORE_HEADERS });
  }

  try {
    const evaluation = await db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${DETECTOR_STATEMENT_TIMEOUT_MS}'`));
      return evaluateDispatchHealth(tx);
    });

    if (!evaluation.tripped) {
      return NextResponse.json(buildCompletedHealthyResponse(), {
        status: 200,
        headers: NO_STORE_HEADERS,
      });
    }

    console.warn('[cloud-agent/dispatch-health] returning 503: detector tripped', {
      eligibleRunCount: evaluation.details.eligibleRunCount,
      stuckRunCount: evaluation.details.stuckRunCount,
      affectedSessionCount: evaluation.details.affectedSessionCount,
      stuckRate: evaluation.details.stuckRate,
      oldestStuckQueuedAt: evaluation.details.oldestStuckQueuedAt,
    });
    return NextResponse.json(buildCompletedUnhealthyResponse(evaluation.details), {
      status: 503,
      headers: NO_STORE_HEADERS,
    });
  } catch (error) {
    captureException(error, {
      tags: {
        endpoint: 'cloud-agent/dispatch-health',
        source: 'cloud_agent_dispatch_health_check',
        detector: 'stuck_dispatch_rate',
      },
    });
    return NextResponse.json(buildFailedOpenHealthyResponse(), {
      status: 200,
      headers: NO_STORE_HEADERS,
    });
  }
}
