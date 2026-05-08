import { createLinearAdapter } from '@chat-adapter/linear';
import { LINEAR_CLIENT_ID, LINEAR_CLIENT_SECRET, LINEAR_WEBHOOK_SECRET } from '@/lib/config.server';

/**
 * Linear chat adapter configured for multi-tenant OAuth installs.
 *
 * Runs in `agent-sessions` mode, which means @-mentions on a Linear issue
 * create an agent session and subsequent replies in that session are routed
 * through the same `bot.onNewMention` pipeline as Slack/GitHub.
 *
 * `userName` is the bot's display name used for mention detection — in
 * production this is "kilo" (matches the Linear app's configured actor),
 * and in non-prod we use "kilo-dev" so local/dev installations don't
 * collide with the production app when the same Linear workspace is
 * connected to both.
 */
export const linearAdapter = createLinearAdapter({
  clientId: LINEAR_CLIENT_ID,
  clientSecret: LINEAR_CLIENT_SECRET,
  webhookSecret: LINEAR_WEBHOOK_SECRET,
  mode: 'agent-sessions',
  userName: process.env.NODE_ENV === 'production' ? 'kilo' : 'kilo-dev',
});
