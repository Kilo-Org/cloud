import { timingSafeEqual } from '@kilocode/encryption';
import { extractBearerToken } from '@kilocode/worker-utils/extract-bearer-token';
import { CODE_REVIEW_HEALTH_SECRET } from '@kilocode/web-shared/lib/config.server';
import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { APP_URL } from '@kilocode/web-shared/lib/constants';
import { db, sql } from '@kilocode/web-shared/lib/drizzle';
import {
  evaluateErrorSpike,
  evaluateSlowReviews,
  type CodeReviewAlertEvaluation,
} from '@/lib/code-reviews/alerting/detectors';
import {
  buildHealthAlert,
  buildHealthResponse,
  type CodeReviewHealthResponse,
} from '@/lib/code-reviews/alerting/health-response';

const DETECTOR_STATEMENT_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 60_000;

type HealthResult = {
  body: CodeReviewHealthResponse;
  status: 200 | 503;
};

let cached: { result: HealthResult; expiresAt: number } | undefined;
let inFlight: Promise<HealthResult> | undefined;

type AlertingDb = Pick<typeof db, 'execute'>;

type Detector = {
  name: string;
  evaluate: (database: AlertingDb) => Promise<CodeReviewAlertEvaluation>;
};

const DETECTORS: Detector[] = [
  { name: 'slow_reviews', evaluate: evaluateSlowReviews },
  { name: 'error_spike', evaluate: evaluateErrorSpike },
];

type UnauthorizedResponse = { healthy: false };

async function evaluateHealth(): Promise<HealthResult> {
  // Run detectors independently so a single broken detector does not mask the
  // alerts the others would have produced. Failed detectors are captured to
  // Sentry; we still return whatever alerts the surviving detectors produced.
  const evaluations = await Promise.all(
    DETECTORS.map(async detector => {
      try {
        return await db.transaction(async tx => {
          await tx.execute(
            sql.raw(`SET LOCAL statement_timeout = '${DETECTOR_STATEMENT_TIMEOUT_MS}'`)
          );
          return detector.evaluate(tx);
        });
      } catch (error) {
        captureException(error, {
          tags: {
            endpoint: 'code-reviews/up',
            source: 'code_review_health_check',
            detector: detector.name,
          },
        });
        return { tripped: false } satisfies CodeReviewAlertEvaluation;
      }
    })
  );

  const alerts = evaluations.flatMap(evaluation =>
    evaluation.tripped ? [buildHealthAlert(evaluation.details, APP_URL)] : []
  );

  const response = buildHealthResponse(alerts);

  if (alerts.length > 0) {
    console.warn('[code-reviews/up] returning 503: code review pipeline detectors tripped', {
      kinds: alerts.map(alert => alert.kind),
    });
    return { body: response, status: 503 };
  }

  // Fail open even when every detector errored: a query timeout or DB error is
  // not evidence of a code review pipeline outage, and treating it as one
  // would create false BetterStack incidents. The errors are already captured
  // to Sentry above.
  return { body: response, status: 200 };
}

export async function GET(
  request: Request
): Promise<NextResponse<CodeReviewHealthResponse | UnauthorizedResponse>> {
  const token = extractBearerToken(request.headers.get('authorization'));
  const headers = { 'Cache-Control': 'no-store' };
  if (!CODE_REVIEW_HEALTH_SECRET || !token || !timingSafeEqual(token, CODE_REVIEW_HEALTH_SECRET)) {
    return NextResponse.json({ healthy: false }, { status: 401, headers });
  }

  let result: HealthResult;
  if (cached && Date.now() < cached.expiresAt) {
    result = cached.result;
  } else {
    inFlight ??= evaluateHealth()
      .then(result => {
        cached = { result, expiresAt: Date.now() + CACHE_TTL_MS };
        return result;
      })
      .finally(() => {
        inFlight = undefined;
      });
    result = await inFlight;
  }
  return NextResponse.json(result.body, { status: result.status, headers });
}
