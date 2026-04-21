import {
  buildChannelOutboundSessionRoute,
  createChannelPluginBase,
  createChatChannelPlugin,
} from 'openclaw/plugin-sdk/core';
import type { ChannelMessageActionContext, OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { createKiloChatClient } from './client';
import { resolveControllerUrl, resolveGatewayToken } from './env';
import { handleKiloChatDeleteAction } from './delete-action';
import { handleKiloChatEditAction } from './edit-action';
import { handleKiloChatMemberInfoAction } from './member-info-action';
import { handleKiloChatReadAction } from './read-action';
import { handleKiloChatReactAction } from './react-action';

const CHANNEL_ID = 'kilo-chat';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

function stripKiloChatPrefix(raw: string): string {
  return raw.trim().replace(/^kilo-chat:/i, '');
}

function isValidUlid(raw: string): boolean {
  return ULID_RE.test(raw);
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
    messaging: {
      normalizeTarget: raw => stripKiloChatPrefix(raw) || undefined,
      parseExplicitTarget: ({ raw }) => {
        const cleaned = stripKiloChatPrefix(raw);
        if (!isValidUlid(cleaned)) return null;
        return { to: cleaned, chatType: 'direct' as const };
      },
      inferTargetChatType: () => 'direct' as const,
      targetResolver: {
        looksLikeId: raw => isValidUlid(stripKiloChatPrefix(raw)),
        hint: '<conversationId (ULID)>',
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const conversationId = stripKiloChatPrefix(target);
        return buildChannelOutboundSessionRoute({
          cfg,
          agentId,
          channel: CHANNEL_ID,
          accountId,
          peer: { kind: 'direct', id: conversationId },
          chatType: 'direct',
          from: `kilo-chat:${accountId ?? ''}`,
        });
      },
    },
    actions: {
      describeMessageTool: () => ({
        actions: ['react', 'read', 'member-info', 'edit', 'delete'] as const,
      }),
      supportsAction: ({ action }: { action: string }) =>
        action === 'react' ||
        action === 'read' ||
        action === 'member-info' ||
        action === 'edit' ||
        action === 'delete',
      resolveExecutionMode: () => 'local' as const,
      handleAction: async (ctx: ChannelMessageActionContext) => {
        const client = makeClient();
        if (ctx.action === 'read') {
          return handleKiloChatReadAction({
            params: ctx.params,
            toolContext: ctx.toolContext,
            client,
          });
        }
        if (ctx.action === 'member-info') {
          return handleKiloChatMemberInfoAction({
            params: ctx.params,
            toolContext: ctx.toolContext,
            client,
          });
        }
        if (ctx.action === 'edit') {
          return handleKiloChatEditAction({
            params: ctx.params,
            toolContext: ctx.toolContext,
            client,
          });
        }
        if (ctx.action === 'delete') {
          return handleKiloChatDeleteAction({
            params: ctx.params,
            toolContext: ctx.toolContext,
            client,
          });
        }
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
          inReplyToMessageId: params.replyToId ?? undefined,
        });
        return { messageId };
      },
    },
  },
});
