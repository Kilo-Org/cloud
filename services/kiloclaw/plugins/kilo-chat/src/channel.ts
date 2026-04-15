import { createChannelPluginBase, createChatChannelPlugin } from 'openclaw/plugin-sdk/core';
import type { ChannelMessageActionContext, OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { createKiloChatClient } from './client';
import { handleKiloChatReactAction } from './react-action';

const CHANNEL_ID = 'kilo-chat';
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

// Single-account plugin. SDK requires `accountId` on the resolved account
// (TResolvedAccount extends { accountId?: string | null }); nothing else on
// the account shape is consumed since we pass no `security` option, so we
// keep the type minimal.
export type ResolvedKiloChatAccount = {
  accountId: string | null;
};

function resolveAccount(_cfg: OpenClawConfig, accountId?: string | null): ResolvedKiloChatAccount {
  return { accountId: accountId ?? null };
}

function inspectAccount(
  cfg: OpenClawConfig,
  _accountId?: string | null
): { enabled: boolean; configured: boolean } {
  const channels = (cfg as { channels?: Record<string, unknown> }).channels;
  const section = channels?.[CHANNEL_ID];
  const enabled =
    typeof section === 'object' &&
    section !== null &&
    (section as { enabled?: unknown }).enabled === true;
  return { enabled, configured: enabled };
}

const pluginBase = createChannelPluginBase({
  id: CHANNEL_ID,
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
  },
  config: {
    listAccountIds: () => [],
    resolveAccount,
    inspectAccount,
  },
});

export const kiloChatPlugin = createChatChannelPlugin<ResolvedKiloChatAccount>({
  base: {
    ...pluginBase,
    actions: {
      describeMessageTool: () => ({
        actions: ['react'] as const,
      }),
      supportsAction: ({ action }: { action: string }) => action === 'react',
      resolveExecutionMode: () => 'local' as const,
      handleAction: async (ctx: ChannelMessageActionContext) => {
        const client = makeClient();
        return handleKiloChatReactAction({
          action: ctx.action,
          cfg: ctx.cfg,
          params: ctx.params,
          toolContext: ctx.toolContext,
          client,
        });
      },
    },
  },
  threading: { topLevelReplyToMode: 'reply' },
  outbound: {
    base: { deliveryMode: 'direct' },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async params => {
        const client = makeClient();
        const { messageId } = await client.createMessage({
          conversationId: params.to,
          content: [{ type: 'text', text: params.text }],
        });
        return { messageId };
      },
    },
  },
});
