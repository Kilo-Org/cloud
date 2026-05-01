import { bot } from '@/lib/bot';
import { PLATFORM } from '@/lib/integrations/core/constants';
import type { PlatformIntegration } from '@kilocode/db';

export async function withBotPlatformAuthContext<T>(
  platformIntegration: PlatformIntegration,
  fn: () => Promise<T>
): Promise<T> {
  await bot.initialize();
  bot.registerSingleton();

  if (platformIntegration.platform === PLATFORM.SLACK) {
    const slackAdapter = bot.getAdapter(PLATFORM.SLACK);
    const installation = await slackAdapter.getInstallation(
      platformIntegration.platform_account_id as string
    );
    if (!installation) {
      throw new Error(`No Slack installation for platform integration ${platformIntegration.id}`);
    }

    return await slackAdapter.withBotToken(installation.botToken, fn);
  }

  return await fn();
}
