import 'server-only';

import {
  postInternalSlackMessage,
  postInternalSlackThreadReply,
} from '@/lib/slack/internal-notifications';

const FEEDBACK_PREVIEW_LIMIT = 500;

/**
 * Sends an app builder feedback notification to the internal Kilo Slack channel.
 * If the feedback text exceeds the preview limit, the full text is posted as a thread reply.
 * Fire-and-forget safe — catches and logs all errors.
 */
export async function notifyAppBuilderFeedback(
  projectId: string,
  feedbackText: string
): Promise<void> {
  const adminLink = `https://app.kilo.ai/admin/app-builder/${projectId}`;
  const trimmedFeedback = feedbackText.trim();
  const wasTruncated = trimmedFeedback.length > FEEDBACK_PREVIEW_LIMIT;
  const previewText =
    trimmedFeedback.slice(0, FEEDBACK_PREVIEW_LIMIT) + (wasTruncated ? '...' : '');

  try {
    const ts = await postInternalSlackMessage(
      [
        {
          type: 'header',
          text: {
            type: 'plain_text',
            text: 'New App Builder feedback :hammer_and_wrench:',
          },
        },
        {
          type: 'section',
          text: { type: 'mrkdwn', text: `<${adminLink}|View project>` },
        },
        {
          type: 'section',
          text: { type: 'plain_text', text: previewText },
        },
      ],
      'New App Builder feedback'
    );

    if (wasTruncated && ts) {
      await postInternalSlackThreadReply(ts, trimmedFeedback);
    }
  } catch (error) {
    console.error('[AppBuilderFeedback] Failed to post to Slack', error);
  }
}
