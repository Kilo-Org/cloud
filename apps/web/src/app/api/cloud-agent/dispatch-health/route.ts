import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { db, sql } from '@/lib/drizzle';
import { evaluateDispatchHealth } from '@/lib/cloud-agent/dispatch-health/detector';
import {
  buildCompletedHealthyResponse,
  buildCompletedUnhealthyResponse,
  buildFailedOpenHealthyResponse,
  type DispatchHealthResponse,
} from '@/lib/cloud-agent/dispatch-health/health-response';

const HEALTH_CHECK_KEY = 'kilo-cloud-agent-dispatch-health-check';
const DETECTOR_STATEMENT_TIMEOUT_MS = 10_000;

type UnauthorizedResponse = { healthy: false };

export async function GET(
  request: Request
): Promise<NextResponse<DispatchHealthResponse | UnauthorizedResponse>> {
  const { searchParams } = new URL(request.url);

  if (searchParams.get('key') !== HEALTH_CHECK_KEY) {
    return NextResponse.json({ healthy: false }, { status: 401 });
  }

  try {
    const evaluation = await db.transaction(async tx => {
      await tx.execute(sql.raw(`SET LOCAL statement_timeout = '${DETECTOR_STATEMENT_TIMEOUT_MS}'`));
      return evaluateDispatchHealth(tx);
    });

    if (!evaluation.tripped) {
      return NextResponse.json(buildCompletedHealthyResponse(), { status: 200 });
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
    });
  } catch (error) {
    captureException(error, {
      tags: {
        endpoint: 'cloud-agent/dispatch-health',
        source: 'cloud_agent_dispatch_health_check',
        detector: 'stuck_dispatch_rate',
      },
    });
    return NextResponse.json(buildFailedOpenHealthyResponse(), { status: 200 });
  }
}
