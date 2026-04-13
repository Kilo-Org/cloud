import {
  createChannelPluginBase,
  createChatChannelPlugin,
} from 'openclaw/plugin-sdk/channel-core';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/channel-core';

const CHANNEL_ID = 'kilo-chat';
const DEFAULT_BASE_URL = 'http://127.0.0.1:18789';

export type ResolvedKiloChatAccount = {
  accountId: string | null;
  baseUrl: string;
  dmPolicy: string | undefined;
  allowFrom: string[];
};

function readChannelSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  const section = channels?.[CHANNEL_ID];
  return typeof section === 'object' && section !== null
    ? (section as Record<string, unknown>)
    : undefined;
}

function resolveAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
): ResolvedKiloChatAccount {
  const section = readChannelSection(cfg) ?? {};
  const baseUrl =
    typeof section.baseUrl === 'string' && section.baseUrl.length > 0
      ? section.baseUrl
      : DEFAULT_BASE_URL;
  const dmPolicy = typeof section.dmPolicy === 'string' ? section.dmPolicy : undefined;
  const allowFrom = Array.isArray(section.allowFrom)
    ? section.allowFrom.filter((v): v is string => typeof v === 'string')
    : [];
  return { accountId: accountId ?? null, baseUrl, dmPolicy, allowFrom };
}

function inspectAccount(
  cfg: OpenClawConfig,
  _accountId?: string | null,
): { enabled: boolean; configured: boolean } {
  const section = readChannelSection(cfg);
  const enabled = section?.enabled === true;
  return { enabled, configured: enabled };
}

export const kiloChatPlugin = createChatChannelPlugin<ResolvedKiloChatAccount>({
  base: createChannelPluginBase({
    id: CHANNEL_ID,
    setup: {
      applyAccountConfig: ({ cfg }) => cfg,
    },
    config: {
      listAccountIds: () => [],
      resolveAccount,
      inspectAccount,
    },
  }),
  threading: { topLevelReplyToMode: 'reply' },
  // outbound + security + inbound added in later tasks
});
