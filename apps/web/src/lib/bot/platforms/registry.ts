import type { GitHubAdapter } from '@chat-adapter/github';
import type { LinearAdapter } from '@chat-adapter/linear';
import type { SlackAdapter } from '@chat-adapter/slack';
import type { TeamsAdapter } from '@chat-adapter/teams';
import { createGitHubBotPlatform } from '@/lib/bot/platforms/github';
import { createLinearBotPlatform } from '@/lib/bot/platforms/linear';
import { createSlackBotPlatform } from '@/lib/bot/platforms/slack';
import { createTeamsBotPlatform } from '@/lib/bot/platforms/teams';
import type { BotPlatform } from '@/lib/bot/platforms/types';

export type BotPlatformRegistry = {
  get(platform: string): BotPlatform | null;
  getByAdapter(adapter: { name: string }): BotPlatform | null;
  require(platform: string): BotPlatform;
  requireByAdapter(adapter: { name: string }): BotPlatform;
};

type BotPlatformRegistryParams = {
  slackAdapter: SlackAdapter;
  githubAdapter: GitHubAdapter;
  linearAdapter: LinearAdapter;
  teamsAdapter: TeamsAdapter | null;
};

function createPlatformMap(platforms: BotPlatform[]): Map<string, BotPlatform> {
  return new Map(platforms.map(platform => [platform.platform, platform]));
}

export function createBotPlatformRegistry(params: BotPlatformRegistryParams): BotPlatformRegistry {
  const platforms = [
    createGitHubBotPlatform(params.githubAdapter),
    createSlackBotPlatform(params.slackAdapter),
    createLinearBotPlatform(params.linearAdapter),
    ...(params.teamsAdapter ? [createTeamsBotPlatform(params.teamsAdapter)] : []),
  ];
  const platformMap = createPlatformMap(platforms);

  return {
    get(platform) {
      return platformMap.get(platform) ?? null;
    },
    getByAdapter(adapter) {
      return platformMap.get(adapter.name) ?? null;
    },
    require(platform) {
      const botPlatform = platformMap.get(platform);
      if (!botPlatform) throw new Error(`PlatformNotSupported: ${platform}`);
      return botPlatform;
    },
    requireByAdapter(adapter) {
      const botPlatform = platformMap.get(adapter.name);
      if (!botPlatform) throw new Error(`PlatformNotSupported: ${adapter.name}`);
      return botPlatform;
    },
  };
}
