import { Type } from '@sinclair/typebox';
import {
  buildChannelOutboundSessionRoute,
  createChannelPluginBase,
  createChatChannelPlugin,
} from 'openclaw/plugin-sdk/core';
import type { ChannelMessageActionContext, OpenClawConfig } from 'openclaw/plugin-sdk/core';
import { loadOutboundMediaFromUrl } from 'openclaw/plugin-sdk/outbound-media';
import { createKiloChatClient, type ContentBlock } from './client';
import { ATTACHMENT_MAX_BYTES } from './synced/schemas';
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

// Capabilities advertised to the kilo-chat backend so clients can render
// matching affordances (e.g. attachment upload UI). Threaded through every
// bot-status ping the plugin emits.
export const PLUGIN_CAPABILITIES = ['attachments'] as const;
const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/i;
const CONVERSATION_TARGET_ALIASES = ['conversationId', 'groupId'];

function isValidUlid(raw: string): boolean {
  return ULID_RE.test(raw);
}

// Filename fallbacks when the SDK's media loader does not produce one (e.g.
// the source URL had no path or extension). Keep this conservative — kilo-chat
// stores the filename in the attachment row and surfaces it as Content-Disposition.
const DEFAULT_FILENAME_BY_MIME: Record<string, string> = {
  'image/png': 'image.png',
  'image/jpeg': 'image.jpg',
  'image/gif': 'image.gif',
  'image/webp': 'image.webp',
  'image/heic': 'image.heic',
  'image/heif': 'image.heif',
  'video/mp4': 'video.mp4',
  'video/quicktime': 'video.mov',
  'audio/mpeg': 'audio.mp3',
  'audio/mp4': 'audio.m4a',
  'audio/ogg': 'audio.ogg',
  'audio/wav': 'audio.wav',
  'application/pdf': 'document.pdf',
};

type LoadedOutboundMedia = {
  buffer: Buffer;
  contentType?: string;
  fileName?: string;
};

// Test seam — allows tests to inject a fake fetch without mocking global fetch,
// and a fake media loader to avoid touching the real network / fs.
export const __pluginInternals: {
  fetchImpl: typeof fetch | undefined;
  loadMediaImpl: ((mediaUrl: string) => Promise<LoadedOutboundMedia>) | undefined;
} = {
  fetchImpl: undefined,
  loadMediaImpl: undefined,
};

function resolveFilename(contentType: string | undefined, suggested: string | undefined): string {
  if (suggested && suggested.length > 0) return suggested;
  if (contentType && DEFAULT_FILENAME_BY_MIME[contentType]) {
    return DEFAULT_FILENAME_BY_MIME[contentType];
  }
  return 'file.bin';
}

async function loadOutboundMedia(mediaUrl: string): Promise<LoadedOutboundMedia> {
  if (__pluginInternals.loadMediaImpl) return __pluginInternals.loadMediaImpl(mediaUrl);
  const loaded = await loadOutboundMediaFromUrl(mediaUrl, {
    maxBytes: ATTACHMENT_MAX_BYTES,
  });
  return {
    buffer: Buffer.isBuffer(loaded.buffer) ? loaded.buffer : Buffer.from(loaded.buffer),
    contentType: loaded.contentType,
    fileName: loaded.fileName,
  };
}

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
  agentPrompt: {
    messageToolHints: () => [
      '- Kilo Chat uses the shared `message` tool. Prefer `target` for explicit conversation destinations; omit it to act in the current conversation when supported.',
      '- `send`: pass `message` plus `target`; `conversationId` and `groupId` are accepted compatibility aliases for the target conversation.',
      '- Kilo Chat actions: `channel-list` lists conversations with optional `limit`; `channel-create` creates a conversation with optional `name`.',
      '- `read`: omit `target` for the current conversation, or pass `target`/`conversationId`; use `limit` and `before` for pagination.',
      '- `react`: pass `messageId` and the actual emoji in `emoji`; set `remove=true` to remove that emoji. If `messageId` is omitted, the current inbound message is used when available.',
      '- `edit` and `delete`: pass `messageId`; `edit` also requires replacement `message` text.',
      '- `member-info`: use `memberId` or `userId` to inspect one member; omit both to list members. Do not use `target` for the member id.',
      '- `renameGroup`: pass `conversationId` or `groupId` plus `name`.',
    ],
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
          void client.sendBotStatus({
            online,
            at: Date.now(),
            capabilities: [...PLUGIN_CAPABILITIES],
          });
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
            conversationId: Type.Optional(
              Type.String({
                description:
                  'Kilo Chat conversation id. Prefer `target` for OpenClaw-native sends, but this is accepted as a compatibility alias for `send`, `read`, `react`, `edit`, `delete`, and `renameGroup` when not acting on the current conversation.',
              })
            ),
            groupId: Type.Optional(
              Type.String({
                description:
                  'Alias for `conversationId`. Accepted for `send`, `read`, `react`, `edit`, `delete`, and `renameGroup`; required for `renameGroup` if `conversationId` is omitted.',
              })
            ),
            messageId: Type.Optional(
              Type.String({
                description:
                  'Target Kilo Chat message id for `react`, `edit`, and `delete`. Defaults to the current inbound message when available.',
              })
            ),
            message: Type.Optional(
              Type.String({
                description: 'Message body for `send` and replacement text for `edit`.',
              })
            ),
            emoji: Type.Optional(
              Type.String({
                description: 'Actual emoji for `react`, for example 👍.',
              })
            ),
            remove: Type.Optional(
              Type.Boolean({
                description: 'For `react`, remove the given emoji reaction instead of adding it.',
              })
            ),
            name: Type.Optional(
              Type.String({
                description: 'Conversation title for `channel-create` or `renameGroup`.',
              })
            ),
            limit: Type.Optional(
              Type.Number({
                description:
                  'Maximum conversations or messages to return for `channel-list` or `read`.',
              })
            ),
            before: Type.Optional(
              Type.String({
                description:
                  'Pagination cursor for `read`; use the `nextCursor` returned by a previous read.',
              })
            ),
            memberId: Type.Optional(
              Type.String({
                description:
                  'Member/user id to inspect with `member-info`. Omit to list all members.',
              })
            ),
            userId: Type.Optional(
              Type.String({
                description: 'Alias for `memberId` for `member-info`.',
              })
            ),
          },
          visibility: 'current-channel' as const,
        },
      }),
      // Tell the OpenClaw message-tool runtime that `groupId`/`conversationId`
      // count as destination fields so explicit Kilo Chat conversations are not
      // overwritten by the current conversation during tool normalization.
      messageActionTargetAliases: {
        send: { aliases: CONVERSATION_TARGET_ALIASES },
        read: { aliases: CONVERSATION_TARGET_ALIASES },
        react: { aliases: CONVERSATION_TARGET_ALIASES },
        edit: { aliases: CONVERSATION_TARGET_ALIASES },
        delete: { aliases: CONVERSATION_TARGET_ALIASES },
        renameGroup: { aliases: CONVERSATION_TARGET_ALIASES },
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
      sendMedia: async params => {
        const client = makeClient();
        const conversationId = stripPrefix(params.to);
        const media = await loadOutboundMedia(params.mediaUrl);
        const mimeType = media.contentType ?? 'application/octet-stream';
        const filename = resolveFilename(media.contentType, media.fileName);
        const size = media.buffer.length;

        const init = await client.initAttachment({
          conversationId,
          mimeType,
          size,
          filename,
        });

        const putFetch = __pluginInternals.fetchImpl ?? fetch;
        const putResponse = await putFetch(init.putUrl, {
          method: 'PUT',
          headers: init.putHeaders,
          body: media.buffer,
        });
        if (!putResponse.ok) {
          throw new Error(
            `kilo-chat: R2 PUT responded ${putResponse.status}: ${await putResponse.text().catch(() => '')}`
          );
        }
        // R2 returns an empty body on PUT — drain it just in case to avoid
        // hanging the keep-alive connection.
        void putResponse.body?.cancel();

        const caption = params.text ?? '';
        const content: ContentBlock[] = [
          {
            type: 'attachment',
            attachmentId: init.attachmentId,
            mimeType,
            size,
            filename,
          },
        ];
        if (caption.length > 0) {
          content.push({ type: 'text', text: caption });
        }

        const { messageId } = await client.createMessage({
          conversationId,
          content,
          inReplyToMessageId: params.replyToId ?? undefined,
        });
        return { messageId };
      },
    },
  },
});
