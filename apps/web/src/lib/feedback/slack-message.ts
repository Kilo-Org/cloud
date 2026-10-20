import type { AnyBlock } from '@slack/types';
import { FeedbackFor, FeedbackSource } from '@/lib/feedback/enums';
import { escapeSlackLabel, truncateSlackText } from '@/lib/slack/slack-escape';

/**
 * Slack payload builders for the two feedback surfaces.
 *
 * Everything a caller can influence is either escaped before it reaches an
 * `mrkdwn` field or carried in a `plain_text` block, which Slack renders without
 * parsing markup. The `text` fallback is fixed copy, so the notification preview
 * cannot carry caller text either. The builders are pure: they take the input a
 * route already validated and return the JSON body of the incoming-webhook POST.
 */

/** Longest caller-supplied metadata value rendered in an mrkdwn field. */
const METADATA_LIMIT = 200;

/** Longest feedback body forwarded to Slack; the stored row keeps the full text. */
const USER_FEEDBACK_BODY_LIMIT = 2_000;
const CLOUD_AGENT_FEEDBACK_BODY_LIMIT = 500;

export type FeedbackSlackMessage = {
  text: string;
  blocks: AnyBlock[];
  unfurl_links: false;
  unfurl_media: false;
};

function metadataValue(value: string): string {
  // Escape first, then cap, so the escaped value stays inside the section limit.
  return truncateSlackText(escapeSlackLabel(value), METADATA_LIMIT);
}

function bodySection(label: string, value: string, limit: number): AnyBlock {
  const trimmed = value.trim();
  return {
    type: 'section',
    text: {
      type: 'plain_text',
      text: `${label}\n${trimmed ? truncateSlackText(trimmed, limit) : '<empty>'}`,
    },
  };
}

export type UserFeedbackSlackInput = {
  userId: string;
  feedbackText?: string;
  feedbackFor?: string;
  source?: string;
  feedbackBatch?: string;
};

/** Message for the shared feedback service (`feedback.submit`, HTTP `/feedback`). */
export function buildUserFeedbackSlackMessage(input: UserFeedbackSlackInput): FeedbackSlackMessage {
  const metadataLines = [
    `• user: ${metadataValue(input.userId)}`,
    `• for: ${metadataValue(input.feedbackFor ?? FeedbackFor.Unknown)}`,
    `• source: ${metadataValue(input.source ?? FeedbackSource.Unknown)}`,
    ...(input.feedbackBatch ? [`• batch: ${metadataValue(input.feedbackBatch)}`] : []),
  ];

  return {
    text: 'New user feedback',
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*New user feedback:* :old_man_yells_at_kilo:' },
      },
      { type: 'section', text: { type: 'mrkdwn', text: metadataLines.join('\n') } },
      bodySection('• raw feedback:', input.feedbackText ?? '', USER_FEEDBACK_BODY_LIMIT),
    ],
  };
}

export type CloudAgentFeedbackSlackInput = {
  /** Canonical Kilo session id, already validated by the caller's input schema. */
  kiloSessionId?: string;
  /** Human label for the session type; omitted when the caller did not send one. */
  sessionTypeLabel?: string;
  feedbackText: string;
};

/** Message for `cloudAgentNextFeedback.create`. */
export function buildCloudAgentFeedbackSlackMessage(
  input: CloudAgentFeedbackSlackInput
): FeedbackSlackMessage {
  const sessionLink = input.kiloSessionId
    ? `<https://app.kilo.ai/admin/session-traces?sessionId=${encodeURIComponent(input.kiloSessionId)}|${escapeSlackLabel(input.kiloSessionId)}>`
    : '_unknown_';

  const metadataLines = [
    `• session: ${sessionLink}`,
    `• session type: ${
      input.sessionTypeLabel ? escapeSlackLabel(input.sessionTypeLabel) : '_unknown_'
    }`,
  ];

  return {
    text: 'New Cloud Agent feedback',
    unfurl_links: false,
    unfurl_media: false,
    blocks: [
      {
        type: 'section',
        text: { type: 'mrkdwn', text: '*New Cloud Agent feedback:* :robot_face:' },
      },
      { type: 'section', text: { type: 'mrkdwn', text: metadataLines.join('\n') } },
      bodySection('• feedback:', input.feedbackText, CLOUD_AGENT_FEEDBACK_BODY_LIMIT),
    ],
  };
}
