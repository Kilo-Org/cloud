import type { CodeReviewAlertDetails } from './detectors';
import {
  CODE_REVIEW_ALERT_SEVERITY,
  CODE_REVIEW_ALERT_WINDOW_MINUTES,
  ERROR_SPIKE_FRACTION,
  ERROR_SPIKE_MIN_FAILURES,
  FAILURE_RATE_THRESHOLD,
  STUCK_COUNT_THRESHOLD,
  STUCK_QUEUED_MINUTES,
  STUCK_RUNNING_MINUTES,
  type CodeReviewAlertSeverity,
} from './thresholds';

type SlackTextObject = {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
};

type SlackHeaderBlock = {
  type: 'header';
  text: SlackTextObject;
};

type SlackSectionBlock = {
  type: 'section';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
};

export type CodeReviewSlackMessage = {
  blocks: (SlackHeaderBlock | SlackSectionBlock)[];
};

function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

function formatReason(reason: string): string {
  return reason.replaceAll('_', ' ');
}

function severityLabel(severity: CodeReviewAlertSeverity): string {
  return severity === 'page' ? ':rotating_light: PAGE' : ':ticket: TICKET';
}

function adminCodeReviewsUrl(appUrl: string): string {
  return new URL('/admin/code-reviews', appUrl).toString();
}

function typeLabel(details: CodeReviewAlertDetails): string {
  switch (details.kind) {
    case 'failure_rate':
      return 'High Failure Rate';
    case 'stuck_reviews':
      return 'Stuck Reviews';
    case 'no_completions':
      return 'No Completions';
    case 'error_spike':
      return 'Error Category Spike';
  }
}

function fieldsForDetails(details: CodeReviewAlertDetails): SlackTextObject[] {
  switch (details.kind) {
    case 'failure_rate':
      return [
        {
          type: 'mrkdwn',
          text: `*Type:*
High Failure Rate`,
        },
        {
          type: 'mrkdwn',
          text: `*Window:*
${CODE_REVIEW_ALERT_WINDOW_MINUTES} min`,
        },
        {
          type: 'mrkdwn',
          text: `*Failure rate:*
${formatPercent(details.rate)} (${details.failures}/${details.total})`,
        },
        {
          type: 'mrkdwn',
          text: `*Threshold:*
> ${formatPercent(FAILURE_RATE_THRESHOLD)}`,
        },
      ];
    case 'stuck_reviews':
      return [
        {
          type: 'mrkdwn',
          text: `*Type:*
Stuck Reviews`,
        },
        {
          type: 'mrkdwn',
          text: `*Queued > ${STUCK_QUEUED_MINUTES}m:*
${details.queuedCount}`,
        },
        {
          type: 'mrkdwn',
          text: `*Running > ${STUCK_RUNNING_MINUTES / 60}h:*
${details.runningCount}`,
        },
        {
          type: 'mrkdwn',
          text: `*Threshold:*
>= ${STUCK_COUNT_THRESHOLD} of either`,
        },
      ];
    case 'no_completions':
      return [
        {
          type: 'mrkdwn',
          text: `*Type:*
No Completions`,
        },
        {
          type: 'mrkdwn',
          text: `*Window:*
${CODE_REVIEW_ALERT_WINDOW_MINUTES} min`,
        },
        {
          type: 'mrkdwn',
          text: `*Created:*
${details.createdCount}`,
        },
        {
          type: 'mrkdwn',
          text: `*Completed:*
0`,
        },
      ];
    case 'error_spike':
      return [
        {
          type: 'mrkdwn',
          text: `*Type:*
Error Category Spike`,
        },
        {
          type: 'mrkdwn',
          text: `*Window:*
${CODE_REVIEW_ALERT_WINDOW_MINUTES} min`,
        },
        {
          type: 'mrkdwn',
          text: `*Top reason:*
${formatReason(details.reason)}`,
        },
        {
          type: 'mrkdwn',
          text: `*Share:*
${formatPercent(details.share)} (${details.count}/${details.total})`,
        },
      ];
  }
}

function summaryForDetails(details: CodeReviewAlertDetails): string {
  switch (details.kind) {
    case 'failure_rate': {
      const topReason = details.topReason
        ? `\nTop reason: ${formatReason(details.topReason)} (${details.topReasonCount ?? 0})`
        : '';
      return `System failures exceeded the pipeline threshold.${topReason}`;
    }
    case 'stuck_reviews':
      return `${details.queuedCount} queued and ${details.runningCount} running reviews are beyond recovery thresholds.`;
    case 'no_completions':
      return `${details.createdCount} reviews were created with zero completions in the current window.`;
    case 'error_spike':
      return `One terminal reason is >= ${formatPercent(ERROR_SPIKE_FRACTION)} of failures with at least ${ERROR_SPIKE_MIN_FAILURES} failures.`;
  }
}

export function buildCodeReviewAlertMessage(
  details: CodeReviewAlertDetails,
  appUrl: string,
  severity: CodeReviewAlertSeverity = CODE_REVIEW_ALERT_SEVERITY
): CodeReviewSlackMessage {
  const dashboardUrl = adminCodeReviewsUrl(appUrl);

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${severityLabel(severity)} — Code Review Pipeline Health`,
          emoji: true,
        },
      },
      {
        type: 'section',
        fields: fieldsForDetails(details),
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*${typeLabel(details)}*\n${summaryForDetails(details)}\n<${dashboardUrl}|View admin dashboard>`,
        },
      },
    ],
  };
}
