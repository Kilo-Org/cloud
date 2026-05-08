import type { WebClient } from '@slack/web-api';

/**
 * Get a permalink URL for a Slack message.
 * The permalink can be used to link directly to the message in Slack.
 *
 * @param client - The Slack WebClient initialized with the workspace access token
 * @param channelId - The Slack channel ID
 * @param messageTs - The message timestamp
 * @returns The permalink URL, or undefined if not available
 */
export async function getSlackMessagePermalink(
  client: WebClient,
  channelId: string,
  messageTs: string
): Promise<string | undefined> {
  try {
    const result = await client.chat.getPermalink({
      channel: channelId,
      message_ts: messageTs,
    });

    if (!result.ok || !result.permalink) {
      return undefined;
    }

    return result.permalink;
  } catch {
    return undefined;
  }
}
