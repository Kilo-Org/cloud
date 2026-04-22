import type { KiloClawEnv } from '../../types';
import type { PersistedState } from '../../schemas/instance-config';
import { decryptChannelTokens, EncryptionConfigurationError } from '../../utils/encryption';

export type ChannelConfigPatch = {
  channels: {
    telegram?: {
      botToken: string;
      enabled: true;
      dmPolicy: string;
    };
    discord?: {
      token: string;
      enabled: true;
      dm: {
        policy: string;
      };
    };
    slack?: {
      botToken: string;
      appToken: string;
      enabled: true;
    };
  };
  plugins: {
    entries: {
      telegram?: { enabled: true };
      discord?: { enabled: true };
      slack?: { enabled: true };
    };
  };
};

/**
 * Builds the additive live channel patch sent to controller /_kilo/config/patch.
 * Keep this in sync with controller/src/config-writer.ts channel semantics.
 */
export function buildChannelConfigPatch(
  env: Pick<KiloClawEnv, 'AGENT_ENV_VARS_PRIVATE_KEY' | 'TELEGRAM_DM_POLICY' | 'DISCORD_DM_POLICY'>,
  channels: PersistedState['channels']
): ChannelConfigPatch | null {
  if (!channels) return null;
  if (!env.AGENT_ENV_VARS_PRIVATE_KEY) {
    throw new EncryptionConfigurationError(
      'AGENT_ENV_VARS_PRIVATE_KEY is required to build live channel config patch'
    );
  }

  const channelEnv = decryptChannelTokens(channels, env.AGENT_ENV_VARS_PRIVATE_KEY);
  const patch: ChannelConfigPatch = {
    channels: {},
    plugins: { entries: {} },
  };

  if (channelEnv.TELEGRAM_BOT_TOKEN) {
    const dmPolicy = env.TELEGRAM_DM_POLICY || 'pairing';
    patch.channels.telegram = {
      botToken: channelEnv.TELEGRAM_BOT_TOKEN,
      enabled: true,
      dmPolicy,
    };
    patch.plugins.entries.telegram = { enabled: true };
  }

  if (channelEnv.DISCORD_BOT_TOKEN) {
    const dmPolicy = env.DISCORD_DM_POLICY || 'pairing';
    patch.channels.discord = {
      token: channelEnv.DISCORD_BOT_TOKEN,
      enabled: true,
      dm: {
        policy: dmPolicy,
      },
    };
    patch.plugins.entries.discord = { enabled: true };
  }

  if (channelEnv.SLACK_BOT_TOKEN && channelEnv.SLACK_APP_TOKEN) {
    patch.channels.slack = {
      botToken: channelEnv.SLACK_BOT_TOKEN,
      appToken: channelEnv.SLACK_APP_TOKEN,
      enabled: true,
    };
    patch.plugins.entries.slack = { enabled: true };
  }

  return Object.keys(patch.channels).length > 0 ? patch : null;
}
