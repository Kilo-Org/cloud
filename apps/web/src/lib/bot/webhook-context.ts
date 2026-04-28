import 'server-only';
import { AsyncLocalStorage } from 'node:async_hooks';

type BotWebhookContext = {
  slackTeamId?: string;
};

const botWebhookContext = new AsyncLocalStorage<BotWebhookContext>();

export function runWithBotWebhookContext<T>(context: BotWebhookContext, callback: () => T): T {
  return botWebhookContext.run(context, callback);
}

export function getBotWebhookContext(): BotWebhookContext {
  return botWebhookContext.getStore() ?? {};
}
