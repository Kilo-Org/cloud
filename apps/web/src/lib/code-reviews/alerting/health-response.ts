import type { CodeReviewAlertDetails } from './detectors';
import { CODE_REVIEW_ALERT_SEVERITY, type CodeReviewAlertSeverity } from './thresholds';

export const CODE_REVIEW_RUNBOOK_URL =
  'https://github.com/Kilo-Org/on-call/blob/main/runbooks/code-review-pipeline-health.md';

type AlertKindLabel = Record<CodeReviewAlertDetails['kind'], string>;

const ALERT_KIND_LABELS: AlertKindLabel = {
  slow_reviews: 'Slow Reviews',
  error_spike: 'Error Spike',
};

type CodeReviewHealthAlertCommon = {
  label: string;
  severity: CodeReviewAlertSeverity;
  adminUrl: string;
  runbookUrl: string;
};

export type CodeReviewHealthAlert = CodeReviewAlertDetails & CodeReviewHealthAlertCommon;

export type CodeReviewHealthResponse = {
  healthy: boolean;
  alerts: CodeReviewHealthAlert[];
  metadata: {
    timestamp: string;
    runbookUrl: string;
  };
};

function adminCodeReviewsUrl(appUrl: string): string {
  return new URL('/admin/code-reviews', appUrl).toString();
}

export function buildHealthAlert(
  details: CodeReviewAlertDetails,
  appUrl: string
): CodeReviewHealthAlert {
  return {
    ...details,
    label: ALERT_KIND_LABELS[details.kind],
    severity: CODE_REVIEW_ALERT_SEVERITY,
    adminUrl: adminCodeReviewsUrl(appUrl),
    runbookUrl: CODE_REVIEW_RUNBOOK_URL,
  };
}

export function buildHealthResponse(
  alerts: CodeReviewHealthAlert[],
  timestamp: Date = new Date()
): CodeReviewHealthResponse {
  return {
    healthy: alerts.length === 0,
    alerts,
    metadata: {
      timestamp: timestamp.toISOString(),
      runbookUrl: CODE_REVIEW_RUNBOOK_URL,
    },
  };
}
