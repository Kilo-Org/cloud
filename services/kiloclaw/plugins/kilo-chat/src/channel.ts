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
export const DEFAULT_ACCOUNT_ID = 'default';
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
  const section: unknown = cfg.channels?.[CHANNEL_ID];
  const enabled =
    typeof section === 'object' &&
    section !== null &&
    'enabled' in section &&
    section.enabled === true;
  return { enabled, configured: enabled };
}

const pluginBase = createChannelPluginBase({
  id: CHANNEL_ID,
  meta: {
    label: 'Kilo Chat',
    selectionLabel: 'Kilo Chat',
    docsPath: '/channels/kilo-chat',
    blurb: "Kilo's hosted chat channel for OpenClaw instances.",
    markdownCapable: true,
  },
  setup: {
    applyAccountConfig: ({ cfg }) => cfg,
  },
  config: {
    listAccountIds: () => ['default'],
    resolveAccount,
    inspectAccount,
  },
});

// Webhook-based channel — no long-running monitor needed. A minimal
// gateway.startAccount ensures the approval handler bootstrap runs and
// the native runtime can deliver rich approval messages.

export const kiloChatPlugin = createChatChannelPlugin<ResolvedKiloChatAccount>({
  base: {
    ...pluginBase,
    capabilities: { chatTypes: ['direct'] },
    gateway: {
      startAccount: async ({ abortSignal, channelRuntime }) => {
        // Register the approval native runtime context on the gateway's channel
        // runtime so the approval handler bootstrap can discover it.
        if (channelRuntime?.runtimeContexts) {
          channelRuntime.runtimeContexts.register({
            channelId: CHANNEL_ID,
            accountId: 'default',
            capability: CHANNEL_APPROVAL_NATIVE_RUNTIME_CONTEXT_CAPABILITY,
            context: {},
            abortSignal,
          });
        }

        // Bot-status is driven by client polling (kilo-chat sends a
        // `bot.status_request` webhook on demand and the plugin replies).
        // We still emit one startup ping so the server cache reflects
        // "online" before the first poll, and one shutdown ping so a
        // graceful abort flips the UI to offline immediately rather than
        // waiting for cache staleness.
        const client = makeClient();
        const sendPresence = (online: boolean) => {
          void client.sendBotStatus({ online, at: Date.now() });
        };
        sendPresence(true);
        abortSignal.addEventListener(
          'abort',
          () => {
            sendPresence(false);
          },
          { once: true }
        );

        // Keep alive until the account is stopped.
        await new Promise<void>(resolve => {
          abortSignal.addEventListener('abort', () => resolve(), { once: true });
        });
      },
    },
    approvalCapability: createKiloChatApprovalCapability(),
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
          from: `kilo-chat:${accountId ?? DEFAULT_ACCOUNT_ID}`,
          to: `kilo-chat:${conversationId}`,
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
            groupId: Type.Optional(
              Type.String({
                description:
                  'Conversation/group id. Required for `renameGroup` (must be the target conversation, not the current one). Optional elsewhere — falls back to the current conversation.',
              })
            ),
            target: Type.Optional(
              Type.String({
                description: 'Member id to inspect with `member-info`. Omit to list all members.',
              })
            ),
          },
          visibility: 'current-channel' as const,
        },
      }),
      // Tell the OpenClaw message-tool runtime that `groupId`/`conversationId`
      // count as a target for `renameGroup`. Without this, the runtime treats
      // the action as targetless and injects `toolContext.currentChannelId`
      // as `to`, which would silently rename the active conversation instead
      // of the one the caller specified.
      messageActionTargetAliases: {
        renameGroup: { aliases: ['groupId', 'conversationId'] },
      },
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
        if (ctx.action === 'react') {
          return handleKiloChatReactAction({
            action: ctx.action,
            cfg: ctx.cfg,
            params: ctx.params,
            toolContext: ctx.toolContext,
            client,
          });
        }
        throw new Error(`kilo-chat: unsupported action "${ctx.action}"`);
      },
    },
  },
  threading: { topLevelReplyToMode: 'reply' },
  outbound: {
    base: {
      deliveryMode: 'direct',
      shouldSuppressLocalPayloadPrompt: ({ payload }) =>
        getExecApprovalReplyMetadata(payload) !== null,
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
