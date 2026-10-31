import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { UPTIME_PROBE_SECRET } from '@kilocode/web-shared/lib/config.server';
import { readDb, sql } from '@kilocode/web-shared/lib/drizzle';
import { microdollar_usage } from '@kilocode/db/schema';
import { NextResponse } from 'next/server';
import { and, gte, gt } from 'drizzle-orm';
import { captureException } from '@sentry/nextjs';

const CACHE_TTL_MS = 60_000;
const NO_STORE_HEADERS = { 'Cache-Control': 'no-store' };

type StatusDetails = { database: boolean; recentAIActivity: boolean };
type ProbeResult = { body: StatusDetails; status: 200 | 503 };

let cached: { result: ProbeResult; expiresAt: number } | undefined;
let inFlight: Promise<ProbeResult> | undefined;

async function evaluateUptime(): Promise<ProbeResult> {
  const statusDetails: StatusDetails = {
    database: false,
    recentAIActivity: false,
  };
  try {
    // A five-minute activity window tolerates replica lag, so this read belongs
    // on the replica instead of the write primary.
    const db_usage_shows_recent_llm_usage = await readDb.query.microdollar_usage.findFirst({
      columns: { id: true },
      where: and(
        gte(microdollar_usage.created_at, sql`NOW() - INTERVAL '5 minutes'`),
        gt(microdollar_usage.cost, 0.0) // openrouter 401's are still logged, so we need to filter those out
      ),
    });

    statusDetails.database = true;
    statusDetails.recentAIActivity = !!db_usage_shows_recent_llm_usage;
  } catch (error) {
    captureException(error, { tags: { endpoint: 'up', source: 'uptime_probe' } });
  }

  const status = statusDetails.database && statusDetails.recentAIActivity ? 200 : 503;
  return { body: statusDetails, status };
}

export async function GET(request: Request): Promise<NextResponse<StatusDetails>> {
  const token = extractBearerToken(request.headers.get('authorization'));
  if (!UPTIME_PROBE_SECRET || !token || !timingSafeEqual(token, UPTIME_PROBE_SECRET)) {
    return NextResponse.json(
      { database: false, recentAIActivity: false },
      { status: 401, headers: NO_STORE_HEADERS }
    );
  }

  let result: ProbeResult;
  if (cached && Date.now() < cached.expiresAt) {
    result = cached.result;
  } else {
    inFlight ??= evaluateUptime()
      .then(evaluation => {
        cached = { result: evaluation, expiresAt: Date.now() + CACHE_TTL_MS };
        return evaluation;
      })
      .finally(() => {
        inFlight = undefined;
      });
    result = await inFlight;
  }

  return NextResponse.json(result.body, { status: result.status, headers: NO_STORE_HEADERS });
}
