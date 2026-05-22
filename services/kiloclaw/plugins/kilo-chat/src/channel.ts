import { readStringParam } from 'openclaw/plugin-sdk/agent-runtime';
import {
  buildChannelOutboundSessionRoute,
  createChannelPluginBase,
  createChatChannelPlugin,
  optionalStringEnum,
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
import { resolveConversationId, stripPrefix } from './action-schemas';
import {
  loadOutboundMedia,
  sendKiloChatLoadedMediaMessage,
  sendKiloChatMediaMessage,
  type LoadedOutboundMedia,
} from './media-delivery';

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

// Test seam — allows tests to inject a fake fetch without mocking global fetch,
// and a fake media loader to avoid touching the real network / fs.
export const __pluginInternals: {
  fetchImpl: typeof fetch | undefined;
  loadMediaImpl: ((mediaUrl: string) => Promise<LoadedOutboundMedia>) | undefined;
} = {
  fetchImpl: undefined,
  loadMediaImpl: undefined,
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

function readSendMediaHint(params: Record<string, unknown>): string | undefined {
  return (
    readStringParam(params, 'media', { trim: false }) ??
    readStringParam(params, 'mediaUrl', { trim: false }) ??
    readStringParam(params, 'path', { trim: false }) ??
    readStringParam(params, 'filePath', { trim: false }) ??
    readStringParam(params, 'fileUrl', { trim: false })
  );
}

function decodeBase64Buffer(raw: string): Buffer {
  const dataUrlMatch = /^data:([^;,]+)?;base64,(.*)$/is.exec(raw.trim());
  const encoded = (dataUrlMatch ? dataUrlMatch[2] : raw).replace(/\s+/g, '');
  const normalized = encoded.replace(/-/g, '+').replace(/_/g, '/');
  if (!normalized || normalized.length % 4 === 1 || !/^[A-Za-z0-9+/]*={0,2}$/.test(normalized)) {
    throw new Error('kilo-chat: buffer must be base64 encoded');
  }
  return Buffer.from(normalized, 'base64');
}

async function handleKiloChatSendAction(ctx: ChannelMessageActionContext): Promise<{
  content: Array<{ type: 'text'; text: string }>;
}> {
  const client = makeClient();
  const conversationId = resolveConversationId(ctx.params, ctx.toolContext);
  const message = readStringParam(ctx.params, 'message', { allowEmpty: true }) ?? '';
  const bufferParam =
    readStringParam(ctx.params, 'buffer', { trim: false }) ??
    readStringParam(ctx.params, 'base64', { trim: false });
  const mediaHint = readSendMediaHint(ctx.params);

  if (bufferParam) {
    const media: LoadedOutboundMedia = {
      buffer: decodeBase64Buffer(bufferParam),
      contentType:
        readStringParam(ctx.params, 'contentType') ??
        readStringParam(ctx.params, 'mimeType') ??
        'application/octet-stream',
      fileName: readStringParam(ctx.params, 'filename'),
    };
    const { messageId } = await sendKiloChatLoadedMediaMessage({
      client,
      conversationId,
      media,
      caption: message,
      inReplyToMessageId: readStringParam(ctx.params, 'replyTo') ?? undefined,
      fetchImpl: __pluginInternals.fetchImpl,
    });
    return { content: [{ type: 'text', text: `Sent message ${messageId}` }] };
  }

  if (mediaHint) {
    const { messageId } = await sendKiloChatMediaMessage({
      client,
      conversationId,
      mediaUrl: mediaHint,
      caption: message,
      inReplyToMessageId: readStringParam(ctx.params, 'replyTo') ?? undefined,
      mediaAccess: ctx.mediaAccess,
      mediaLocalRoots: ctx.mediaLocalRoots,
      mediaReadFile: ctx.mediaReadFile,
      fetchImpl: __pluginInternals.fetchImpl,
      loadMediaImpl: __pluginInternals.loadMediaImpl
        ? mediaUrl => __pluginInternals.loadMediaImpl!(mediaUrl)
        : loadOutboundMedia,
    });
    return { content: [{ type: 'text', text: `Sent message ${messageId}` }] };
  }

  if (!message) {
    throw new Error('kilo-chat: message or media is required for send action');
  }

  const { messageId } = await client.createMessage({
    conversationId,
    content: [{ type: 'text', text: message }],
    inReplyToMessageId: readStringParam(ctx.params, 'replyTo') ?? undefined,
  });
  return { content: [{ type: 'text', text: `Sent message ${messageId}` }] };
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
      '- `send`: pass `message` plus `target`; `conversationId` and `groupId` are accepted compatibility aliases. To send any attachment, pass base64 `buffer`, `filename`, and `contentType`, or pass a local workspace path with `filePath`/`media` and a caption in `message`.',
      '- For generated text files or arbitrary local file types, prefer `send` with `filePath`/`media`, or `upload-file` with base64 `buffer`. Do not use `upload-file` with a local `filePath` for plain text or unknown file types.',
      '- `upload-file`: use for direct file uploads when you already have base64 `buffer`, `filename`, and `contentType`; local `media`/`path`/`filePath` is best for images, audio, video, PDF, and Office documents.',
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
          'send',
          'upload-file',
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
            conversationId: optionalStringEnum([], {
              description:
                'Kilo Chat conversation id. Prefer `target` for OpenClaw-native sends, but this is accepted as a compatibility alias for `send`, `read`, `react`, `edit`, `delete`, and `renameGroup` when not acting on the current conversation.',
            }),
          },
          visibility: 'current-channel' as const,
        },
      }),
      // Tell the OpenClaw message-tool runtime that `groupId`/`conversationId`
      // count as destination fields so explicit Kilo Chat conversations are not
      // overwritten by the current conversation during tool normalization.
      messageActionTargetAliases: {
        send: { aliases: CONVERSATION_TARGET_ALIASES },
        'upload-file': { aliases: CONVERSATION_TARGET_ALIASES },
        read: { aliases: CONVERSATION_TARGET_ALIASES },
        react: { aliases: CONVERSATION_TARGET_ALIASES },
        edit: { aliases: CONVERSATION_TARGET_ALIASES },
        delete: { aliases: CONVERSATION_TARGET_ALIASES },
        renameGroup: { aliases: CONVERSATION_TARGET_ALIASES },
      },
      supportsAction: ({ action }: { action: string }) =>
        action === 'send' ||
        action === 'upload-file' ||
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
        if (ctx.action === 'send' || ctx.action === 'upload-file') {
          return handleKiloChatSendAction(ctx);
        }
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
        const localLoadMediaImpl = __pluginInternals.loadMediaImpl;
        const { messageId } = await sendKiloChatMediaMessage({
          client,
          conversationId,
          mediaUrl: params.mediaUrl ?? '',
          caption: params.text ?? '',
          inReplyToMessageId: params.replyToId ?? undefined,
          mediaAccess: params.mediaAccess,
          mediaLocalRoots: params.mediaLocalRoots,
          mediaReadFile: params.mediaReadFile,
          fetchImpl: __pluginInternals.fetchImpl,
          loadMediaImpl: localLoadMediaImpl
            ? mediaUrl => localLoadMediaImpl(mediaUrl)
            : loadOutboundMedia,
        });
        return { messageId };
      },
    },
  },
});
