import { captureException } from '@sentry/nextjs';
import { NextResponse } from 'next/server';
import { APP_URL } from '@/lib/constants';
import { CRON_SECRET, SLACK_CODE_REVIEW_WEBHOOK_URL } from '@/lib/config.server';
import { db } from '@/lib/drizzle';
import { checkAndRecordAlert } from '@/lib/code-reviews/alerting/dedup-client';
import {
  evaluateErrorCategorySpike,
  evaluateFailureRate,
  evaluateNoCompletions,
  evaluateStuckReviews,
  type CodeReviewAlertDetails,
  type CodeReviewAlertEvaluation,
} from '@/lib/code-reviews/alerting/detectors';
import { buildCodeReviewAlertMessage } from '@/lib/code-reviews/alerting/slack-message';
import {
  CODE_REVIEW_ALERT_SEVERITY,
  type CodeReviewAlertSeverity,
} from '@/lib/code-reviews/alerting/thresholds';

type Detector = {
  name: string;
  evaluate: (database: typeof db) => Promise<CodeReviewAlertEvaluation>;
};

type AlertResult = {
  detector: string;
  alertKey: string;
  suppressed: boolean;
  slack: 'sent' | 'skipped' | 'failed' | 'suppressed';
};

type CronError = {
  detector: string;
  message: string;
};

const DETECTORS: Detector[] = [
  { name: 'failure_rate', evaluate: evaluateFailureRate },
  { name: 'stuck_reviews', evaluate: evaluateStuckReviews },
  { name: 'no_completions', evaluate: evaluateNoCompletions },
  { name: 'error_spike', evaluate: evaluateErrorCategorySpike },
];

function alertKeyForDetails(details: CodeReviewAlertDetails): string {
  if (details.kind === 'error_spike') {
    return `error_spike:${details.reason}`;
  }

  return details.kind;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function postToSlack(details: CodeReviewAlertDetails, webhookUrl: string): Promise<'sent'> {
  let response: Response;
  try {
    response = await fetch(webhookUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        buildCodeReviewAlertMessage(details, APP_URL, CODE_REVIEW_ALERT_SEVERITY)
      ),
      signal: AbortSignal.timeout(5_000),
    });
  } catch (error) {
    throw new Error(`Slack webhook failed: ${errorMessage(error)}`, { cause: error });
  }

  if (!response.ok) {
    let responseText = '';
    try {
      responseText = await response.text();
    } catch {
      responseText = '<unreadable response body>';
    }
    throw new Error(`Slack webhook failed (${response.status}): ${responseText}`);
  }

  return 'sent';
}

async function handleTrippedAlert(
  detector: string,
  details: CodeReviewAlertDetails,
  severity: CodeReviewAlertSeverity
): Promise<AlertResult> {
  const alertKey = alertKeyForDetails(details);
  const webhookUrl = SLACK_CODE_REVIEW_WEBHOOK_URL;

  if (!webhookUrl) {
    console.warn('SLACK_CODE_REVIEW_WEBHOOK_URL is not configured; skipping code review alert');
    return { detector, alertKey, suppressed: false, slack: 'skipped' };
  }

  const { suppressed } = await checkAndRecordAlert(alertKey, severity);

  if (suppressed) {
    return { detector, alertKey, suppressed: true, slack: 'suppressed' };
  }

  const slack = await postToSlack(details, webhookUrl);
  return { detector, alertKey, suppressed: false, slack };
}

export async function GET(request: Request) {
  if (!CRON_SECRET || request.headers.get('authorization') !== `Bearer ${CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  let tripped = 0;
  let sent = 0;
  let suppressed = 0;
  let slack: 'sent' | 'skipped' | 'failed' | 'not_applicable' = 'not_applicable';
  const alerts: AlertResult[] = [];
  const errorSummaries: CronError[] = [];
  const capturedErrors: unknown[] = [];

  for (const detector of DETECTORS) {
    try {
      const evaluation = await detector.evaluate(db);
      if (!evaluation.tripped) continue;

      tripped += 1;
      const result = await handleTrippedAlert(
        detector.name,
        evaluation.details,
        CODE_REVIEW_ALERT_SEVERITY
      );
      alerts.push(result);

      if (result.suppressed) {
        suppressed += 1;
      } else if (result.slack === 'sent') {
        sent += 1;
        slack = 'sent';
      } else if (result.slack === 'skipped' && slack !== 'sent') {
        slack = 'skipped';
      }
    } catch (error) {
      capturedErrors.push(new Error(`${detector.name} detector failed`, { cause: error }));
      errorSummaries.push({ detector: detector.name, message: errorMessage(error) });
      slack = errorSummaries.some(item => item.message.startsWith('Slack webhook failed'))
        ? 'failed'
        : slack;
    }
  }

  if (capturedErrors.length > 0) {
    const details = errorSummaries
      .map(error => `  - ${error.detector}: ${error.message}`)
      .join('\n');
    captureException(
      new AggregateError(
        capturedErrors,
        `Code review alert evaluation failed with ${capturedErrors.length} error(s):\n${details}`
      ),
      { tags: { endpoint: 'cron/code-review-alerts' } }
    );
  }

  return NextResponse.json({
    success: true,
    evaluated: DETECTORS.length,
    tripped,
    sent,
    suppressed,
    slack,
    alerts,
    errors: errorSummaries,
    timestamp: new Date().toISOString(),
  });
}
