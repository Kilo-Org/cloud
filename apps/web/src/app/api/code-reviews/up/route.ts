import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { APP_URL } from '@/lib/constants';
import { db } from '@/lib/drizzle';
import {
  evaluateErrorCategorySpike,
  evaluateFailureRate,
  evaluateNoCompletions,
  evaluateStuckReviews,
  type CodeReviewAlertEvaluation,
} from '@/lib/code-reviews/alerting/detectors';
import {
  buildHealthAlert,
  buildHealthResponse,
  type CodeReviewHealthResponse,
} from '@/lib/code-reviews/alerting/health-response';

const HEALTH_CHECK_KEY = 'kilo-code-reviews-health-check';

type AlertingDb = Pick<typeof db, 'execute'>;

type Detector = {
  name: string;
  evaluate: (database: AlertingDb) => Promise<CodeReviewAlertEvaluation>;
};

const DETECTORS: Detector[] = [
  { name: 'failure_rate', evaluate: evaluateFailureRate },
  { name: 'stuck_reviews', evaluate: evaluateStuckReviews },
  { name: 'no_completions', evaluate: evaluateNoCompletions },
  { name: 'error_spike', evaluate: evaluateErrorCategorySpike },
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

  try {
    const evaluations = await Promise.all(DETECTORS.map(d => d.evaluate(db)));
    const alerts = evaluations
      .filter(
        (evaluation): evaluation is Extract<CodeReviewAlertEvaluation, { tripped: true }> =>
          evaluation.tripped
      )
      .map(evaluation => buildHealthAlert(evaluation.details, APP_URL));

    const response = buildHealthResponse(alerts);

    if (alerts.length > 0) {
      console.warn('[code-reviews/up] returning 503: code review pipeline detectors tripped', {
        kinds: alerts.map(alert => alert.kind),
      });
      return NextResponse.json(response, { status: 503 });
    }

    return NextResponse.json(response, { status: 200 });
  } catch (error) {
    captureException(error, {
      tags: { endpoint: 'code-reviews/up', source: 'code_review_health_check' },
    });

    // Fail open: a query timeout or DB error is not evidence of a code review
    // pipeline outage, and treating it as one would create false incidents.
    return NextResponse.json(buildHealthResponse([]), { status: 200 });
  }
}
