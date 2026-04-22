import { Type } from '@sinclair/typebox';
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
import { handleKiloChatRenameAction } from './rename-action';
import { handleKiloChatListConversationsAction } from './list-conversations-action';
import { handleKiloChatCreateConversationAction } from './create-conversation-action';
import { createKiloChatApprovalCapability } from './approval';
import { getExecApprovalReplyMetadata } from 'openclaw/plugin-sdk/approval-reply-runtime';
import { CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY } from 'openclaw/plugin-sdk/approval-handler-adapter-runtime';
import { stripPrefix } from './action-schemas';

const CHANNEL_ID = 'kilo-chat';
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;

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
    listAccountIds: () => ['default'],
    resolveAccount,
    inspectAccount,
  },
});

export const kiloChatPlugin = createChatChannelPlugin<ResolvedKiloChatAccount>({
  base: {
    ...pluginBase,
    messaging: {
      normalizeTarget: raw => stripPrefix(raw) || undefined,
      parseExplicitTarget: ({ raw }) => {
        const cleaned = stripPrefix(raw);
        if (!isValidUlid(cleaned)) return null;
        return { to: cleaned, chatType: 'direct' as const };
      },
      inferTargetChatType: () => 'direct' as const,
      targetResolver: {
        looksLikeId: raw => isValidUlid(stripPrefix(raw)),
        hint: '<conversationId (ULID)>',
      },
      resolveOutboundSessionRoute: ({ cfg, agentId, accountId, target }) => {
        const conversationId = stripPrefix(target);
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
        actions: [
          'react',
          'read',
          'member-info',
          'edit',
          'delete',
          'renameGroup',
          'channel-list',
          'channel-create',
        ] as const,
        schema: {
          properties: {
            additionalMembers: Type.Optional(
              Type.String({
                description: 'Comma-separated member IDs to add when creating a conversation.',
              })
            ),
          },
          visibility: 'current-channel' as const,
        },
      }),
      supportsAction: ({ action }: { action: string }) =>
        action === 'react' ||
        action === 'read' ||
        action === 'member-info' ||
        action === 'edit' ||
        action === 'delete' ||
        action === 'renameGroup' ||
        action === 'channel-list' ||
        action === 'channel-create',
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
        if (ctx.action === 'renameGroup') {
          return handleKiloChatRenameAction({
            params: ctx.params,
            toolContext: ctx.toolContext,
            client,
          });
        }
        if (ctx.action === 'channel-list') {
          return handleKiloChatListConversationsAction({
            params: ctx.params,
            client,
          });
        }
        if (ctx.action === 'channel-create') {
          return handleKiloChatCreateConversationAction({
            params: ctx.params,
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
    base: {
      deliveryMode: 'direct',
      shouldSuppressLocalPayloadPrompt: ({ payload }) => {
        const meta = getExecApprovalReplyMetadata(payload);
        const result = meta !== null;
        console.log('[kilo-chat:approval] shouldSuppressLocalPayloadPrompt', {
          result,
          hasChannelData: !!payload?.channelData,
          metaApprovalId: meta?.approvalId ?? '(none)',
        });
        return result;
      },
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: async params => {
        const client = makeClient();
        const conversationId = stripPrefix(params.to);
        const { messageId } = await client.createMessage({
          conversationId,
          content: [{ type: 'text', text: params.text }],
          inReplyToMessageId: params.replyToId ?? undefined,
        });
        return { messageId };
      },
    },
  },
});

// Webhook-based channel — no long-running monitor needed. A minimal
// gateway.startAccount ensures the approval handler bootstrap runs and
// the native runtime can deliver rich approval messages.
kiloChatPlugin.gateway = {
  startAccount: async ({ abortSignal, channelRuntime }) => {
    console.log('[kilo-chat] gateway.startAccount called', {
      hasChannelRuntime: !!channelRuntime,
      hasRuntimeContexts: !!channelRuntime?.runtimeContexts,
    });

    // Register the approval native runtime context on the gateway's channel
    // runtime so the approval handler bootstrap can discover it.
    if (channelRuntime?.runtimeContexts) {
      const handle = channelRuntime.runtimeContexts.register({
        channelId: CHANNEL_ID,
        accountId: 'default',
        capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
        context: {},
        abortSignal,
      });
      console.log('[kilo-chat:approval] runtime context registered via channelRuntime', {
        hasDispose: !!handle?.dispose,
      });
    }

    // Keep alive until the account is stopped.
    await new Promise<void>(resolve => {
      abortSignal.addEventListener('abort', () => resolve(), { once: true });
    });
  },
};

kiloChatPlugin.approvalCapability = createKiloChatApprovalCapability();
