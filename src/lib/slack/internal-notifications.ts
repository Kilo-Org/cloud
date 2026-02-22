import 'server-only';

import { WebClient } from '@slack/web-api';
import type { Block, KnownBlock } from '@slack/web-api';
import { SLACK_FEEDBACK_BOT_TOKEN, SLACK_FEEDBACK_CHANNEL_ID } from '@/lib/config.server';

function makeClient(): WebClient {
  if (!SLACK_FEEDBACK_BOT_TOKEN) {
    throw new Error('SLACK_FEEDBACK_BOT_TOKEN is not configured');
  }
  return new WebClient(SLACK_FEEDBACK_BOT_TOKEN);
}

/**
 * Posts a message to the internal Kilo Slack feedback channel.
 * Returns the message ts on success (needed for threading), or undefined if not configured.
 * Throws on API errors.
 */
export async function postInternalSlackMessage(
  blocks: (Block | KnownBlock)[],
  fallbackText: string
): Promise<string | undefined> {
  if (!SLACK_FEEDBACK_BOT_TOKEN || !SLACK_FEEDBACK_CHANNEL_ID) {
    return undefined;
  }

  const client = makeClient();
  const result = await client.chat.postMessage({
    channel: SLACK_FEEDBACK_CHANNEL_ID,
    text: fallbackText,
    unfurl_links: false,
    unfurl_media: false,
    blocks,
  });

  return result.ts;
}

/**
 * Posts a thread reply to an existing message in the internal Kilo Slack feedback channel.
 * Throws on API errors.
 */
export async function postInternalSlackThreadReply(
  threadTs: string,
  text: string
): Promise<void> {
  if (!SLACK_FEEDBACK_BOT_TOKEN || !SLACK_FEEDBACK_CHANNEL_ID) {
    return;
  }

  const client = makeClient();
  await client.chat.postMessage({
    channel: SLACK_FEEDBACK_CHANNEL_ID,
    thread_ts: threadTs,
    text,
  });
}
