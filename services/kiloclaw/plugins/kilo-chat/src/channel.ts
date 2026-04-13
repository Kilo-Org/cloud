import { createChannelPluginBase, createChatChannelPlugin } from 'openclaw/plugin-sdk/core';
import type { OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { resolveChannelPreviewStreamMode } from 'openclaw/plugin-sdk/channel-streaming';
import { createKiloChatClient } from './client';

const CHANNEL_ID = 'kilo-chat';
const DEFAULT_BASE_URL = 'http://127.0.0.1:18789';
const DEFAULT_CONTROLLER_URL = 'http://127.0.0.1:18789';

function resolveControllerUrl(): string {
  return process.env.KILOCLAW_CONTROLLER_URL || DEFAULT_CONTROLLER_URL;
}

function resolveGatewayToken(): string {
  const token = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!token) throw new Error('kilo-chat: OPENCLAW_GATEWAY_TOKEN is required');
  return token;
}

// Test seam — allows tests to inject a fake fetch without mocking global fetch.
export const __pluginInternals = {
  fetchImpl: undefined as typeof fetch | undefined,
};

function makeClient() {
  return createKiloChatClient({
    controllerBaseUrl: resolveControllerUrl(),
    gatewayToken: resolveGatewayToken(),
    fetchImpl: __pluginInternals.fetchImpl,
  });
}

export type ResolvedKiloChatAccount = {
  accountId: string | null;
  baseUrl: string;
  dmPolicy: string | undefined;
  allowFrom: string[];
  streamingMode: 'off' | 'partial' | 'block';
  throttleMs: number;
};

function readChannelSection(cfg: OpenClawConfig): Record<string, unknown> | undefined {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  const section = channels?.[CHANNEL_ID];
  return typeof section === 'object' && section !== null
    ? (section as Record<string, unknown>)
    : undefined;
}

function resolveAccount(cfg: OpenClawConfig, accountId?: string | null): ResolvedKiloChatAccount {
  const section = readChannelSection(cfg) ?? {};
  const baseUrl =
    typeof section.baseUrl === 'string' && section.baseUrl.length > 0
      ? section.baseUrl
      : DEFAULT_BASE_URL;
  const dmPolicy = typeof section.dmPolicy === 'string' ? section.dmPolicy : undefined;
  const allowFrom = Array.isArray(section.allowFrom)
    ? section.allowFrom.filter((v): v is string => typeof v === 'string')
    : [];

  const streamingSection =
    typeof section.streaming === 'object' && section.streaming !== null
      ? (section.streaming as Record<string, unknown>)
      : {};
  const streamingMode = resolveChannelPreviewStreamMode({ streaming: streamingSection }, 'partial');
  const throttleMsRaw = streamingSection['throttleMs'];
  const throttleMs =
    typeof throttleMsRaw === 'number' &&
    Number.isFinite(throttleMsRaw) &&
    throttleMsRaw >= 100 &&
    throttleMsRaw <= 5000
      ? throttleMsRaw
      : 500;

  return { accountId: accountId ?? null, baseUrl, dmPolicy, allowFrom, streamingMode, throttleMs };
}

function inspectAccount(
  cfg: OpenClawConfig,
  _accountId?: string | null
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
  outbound: {
    // FRAGILE: editText/deleteMessage reach `plugin.outbound.attachedResults.*` only
    // because `resolveChatChannelOutbound` in the OpenClaw SDK spreads `outbound.base`
    // verbatim onto the final adapter. If the SDK ever enumerates known `base` keys,
    // these handlers will silently disappear. Consider lobbying OpenClaw for a
    // first-class `base.actions` or `extraOutbound` escape hatch.
    //
    // The OpenClaw SDK's `outbound.base` type doesn't declare an `attachedResults`
    // field, but `resolveChatChannelOutbound` spreads `base` verbatim onto the final
    // adapter, so fields added here become reachable as `plugin.outbound.*` at
    // runtime. Narrow cast keeps `deliveryMode` type-checked.
    base: {
      deliveryMode: 'direct',
      attachedResults: {
        channel: CHANNEL_ID,
        editText: async (params: {
          to: string;
          messageId: string;
          text: string;
          version: number;
        }) => {
          const client = makeClient();
          const result = await client.editMessage({
            conversationId: params.to,
            messageId: params.messageId,
            text: params.text,
            version: params.version,
          });
          return { messageId: result.messageId, version: result.version };
        },
        deleteMessage: async (params: { to: string; messageId: string }) => {
          const client = makeClient();
          await client.deleteMessage({
            conversationId: params.to,
            messageId: params.messageId,
          });
        },
      },
    } as { deliveryMode: 'direct'; attachedResults: unknown },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async params => {
        const client = makeClient();
        const result = await client.sendText({
          conversationId: params.to,
          text: params.text,
        });
        return { messageId: result.messageId };
      },
    },
  },
});
