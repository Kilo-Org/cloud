import { githubAdapter } from '@/lib/bot/github-adapter';
import { linearAdapter } from '@/lib/bot/linear-adapter';
import { slackAdapter } from '@/lib/bot/slack-adapter';
import { createBotPlatformRegistry } from '@/lib/bot/platforms/registry';

export const botPlatforms = createBotPlatformRegistry({
  slackAdapter,
  githubAdapter,
  linearAdapter,
});

export type { BotPlatformRegistry } from '@/lib/bot/platforms/registry';
export type { BotPlatform, RequesterInfo } from '@/lib/bot/platforms/types';
