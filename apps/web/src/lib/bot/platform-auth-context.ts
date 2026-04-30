import { bot } from '@/lib/bot';
import { PLATFORM } from '@/lib/integrations/core/constants';
import { getAccessTokenFromInstallation } from '@/lib/integrations/slack-service';
import type { PlatformIntegration } from '@kilocode/db';

export async function withBotPlatformAuthContext<T>(
  platformIntegration: PlatformIntegration,
  fn: () => Promise<T>
): Promise<T> {
  await bot.initialize();
  bot.registerSingleton();

  if (platformIntegration.platform === PLATFORM.SLACK) {
    const slackAdapter = bot.getAdapter(PLATFORM.SLACK);
    const token = getAccessTokenFromInstallation(platformIntegration);
    if (token) {
      return await slackAdapter.withBotToken(token, fn);
    }

    const teamId = platformIntegration.platform_installation_id;
    if (!teamId) {
      throw new Error(`No Slack team found for platform integration ${platformIntegration.id}`);
    }

    const installation = await slackAdapter.getInstallation(teamId);
    if (!installation?.botToken) {
      throw new Error(
        `No Slack bot token found for platform integration ${platformIntegration.id}`
      );
    }

    return await slackAdapter.withBotToken(installation.botToken, fn);
  }

  return await fn();
}
