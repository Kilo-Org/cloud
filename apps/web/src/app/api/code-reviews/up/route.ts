import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { APP_URL } from '@/lib/constants';
import { db, sql } from '@/lib/drizzle';
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

// Hardcoded query-string filter that the BetterStack monitor passes. Not a
// secret — just a low-friction way to keep scanners and accidental hits from
// running detector queries. Mirrors `apps/web/src/app/api/models/up/route.ts`.
const HEALTH_CHECK_KEY = 'kilo-code-reviews-health-check';
const DETECTOR_STATEMENT_TIMEOUT_MS = 10_000;

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

export async function GET(
  request: Request
): Promise<NextResponse<CodeReviewHealthResponse | UnauthorizedResponse>> {
  const { searchParams } = new URL(request.url);
  const key = searchParams.get('key');

  if (key !== HEALTH_CHECK_KEY) {
    return NextResponse.json({ healthy: false }, { status: 401 });
  }

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
    return NextResponse.json(response, { status: 503 });
  }

  // Fail open even when every detector errored: a query timeout or DB error is
  // not evidence of a code review pipeline outage, and treating it as one
  // would create false BetterStack incidents. The errors are already captured
  // to Sentry above.
  return NextResponse.json(response, { status: 200 });
}
