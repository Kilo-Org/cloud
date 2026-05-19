// Event dispatch for inbound Kilo Chat webhooks. Bridges the validated payload
// into OpenClaw's channel reply pipeline (for message.created) or the approval
// gateway resolver (for action.executed).

import { createChannelReplyPipeline } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from 'openclaw/plugin-sdk/inbound-envelope';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { createNormalizedOutboundDeliverer } from 'openclaw/plugin-sdk/reply-payload';
import { resolveApprovalOverGateway } from 'openclaw/plugin-sdk/approval-gateway-runtime';

import { createKiloChatClient, type KiloChatClient } from '../client.js';
import { resolveControllerUrl, resolveGatewayToken } from '../env.js';
import { DEFAULT_ACCOUNT_ID, PLUGIN_CAPABILITIES } from '../channel.js';
import { readSessionUsage, toContextPayload } from '../bot-status.js';
import { ATTACHMENT_MAX_BYTES } from '../synced/schemas.js';

import { buildDeliverWiring } from './deliver.js';
import { buildTypingParams } from './typing.js';
import type { ActionExecutedPayload, KiloChatInboundPayload } from './schemas.js';

// Test seam — allows tests to inject a fake fetch for the R2 GET path so we
// can exercise the download loop without touching the network.
export const __dispatchInternals: {
  fetchImpl: typeof fetch | undefined;
} = {
  fetchImpl: undefined,
};

type InboundAttachmentMeta = NonNullable<KiloChatInboundPayload['attachments']>[number];

type SaveMediaBuffer = (
  buffer: Buffer,
  contentType?: string,
  subdir?: string,
  maxBytes?: number,
  originalFilename?: string
) => Promise<{ id: string; path: string; size: number; contentType?: string }>;

export type DownloadedAttachments = {
  mediaPaths: string[];
  mediaTypes: string[];
  failedCount: number;
};

async function readResponseBodyCapped(response: Response, maxBytes: number): Promise<Buffer> {
  const declaredLength = response.headers.get('content-length');
  if (declaredLength != null) {
    const size = Number(declaredLength);
    if (Number.isFinite(size) && size > maxBytes) {
      await response.body?.cancel();
      throw new Error(`Attachment exceeds maximum size of ${maxBytes} bytes`);
    }
  }

  const reader = response.body?.getReader();
  if (!reader) {
    const arrayBuffer = await response.arrayBuffer();
    if (arrayBuffer.byteLength > maxBytes) {
      throw new Error(`Attachment exceeds maximum size of ${maxBytes} bytes`);
    }
    return Buffer.from(arrayBuffer);
  }

  const chunks: Buffer[] = [];
  let total = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new Error(`Attachment exceeds maximum size of ${maxBytes} bytes`);
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, total);
}

/**
 * For each inbound attachment, fetch a fresh signed GET URL from the controller,
 * download the bytes, and persist them via `saveMediaBuffer` so the agent runner
 * can address them as local `MediaPath` entries. Failures on individual
 * attachments are logged and the rest of the list is still processed — webhook
 * delivery never fails because a single attachment download flaked. `failedCount`
 * lets callers surface a fallback note to the agent when nothing usable made it
 * through.
 */
export async function downloadInboundAttachments(params: {
  client: KiloChatClient;
  conversationId: string;
  attachments: readonly InboundAttachmentMeta[];
  saveMediaBuffer: SaveMediaBuffer;
  fetchImpl?: typeof fetch;
}): Promise<DownloadedAttachments> {
  const mediaPaths: string[] = [];
  const mediaTypes: string[] = [];
  let failedCount = 0;
  if (params.attachments.length === 0) return { mediaPaths, mediaTypes, failedCount };
  const fetchImpl = params.fetchImpl ?? fetch;

  for (const att of params.attachments) {
    try {
      const signed = await params.client.getAttachmentUrl({
        conversationId: params.conversationId,
        attachmentId: att.attachmentId,
      });
      const response = await fetchImpl(signed.url);
      if (!response.ok) {
        console.warn(
          `[kilo-chat] inbound attachment ${att.attachmentId} download responded ${response.status}; skipping`
        );
        void response.body?.cancel();
        failedCount++;
        continue;
      }
      const buffer = await readResponseBodyCapped(response, ATTACHMENT_MAX_BYTES);
      const saved = await params.saveMediaBuffer(
        buffer,
        att.mimeType,
        'inbound',
        ATTACHMENT_MAX_BYTES,
        att.filename
      );
      mediaPaths.push(saved.path);
      mediaTypes.push(att.mimeType);
    } catch (err) {
      console.warn(`[kilo-chat] inbound attachment ${att.attachmentId} failed:`, err);
      failedCount++;
    }
  }

  return { mediaPaths, mediaTypes, failedCount };
}

export async function handleActionExecuted(
  api: OpenClawPluginApi,
  payload: ActionExecutedPayload
): Promise<void> {
  await resolveApprovalOverGateway({
    cfg: api.config,
    approvalId: payload.groupId,
    decision: payload.value,
    senderId: payload.executedBy,
    clientDisplayName: 'Kilo Chat',
  });
}

// Replies to kilo-chat's `bot.status_request` webhook. Reaching this handler
// at all means the plugin is alive and reachable, so we publish `online: true`
// with the current timestamp. Definitive offline signals (machine gone) are
// detected upstream when the webhook fails to deliver. The `client` arg is
// injectable for tests; production callers omit it.
export async function handleBotStatusRequest(client?: KiloChatClient): Promise<void> {
  const c =
    client ??
    createKiloChatClient({
      controllerBaseUrl: resolveControllerUrl(),
      gatewayToken: resolveGatewayToken(),
    });
  await c.sendBotStatus({
    online: true,
    at: Date.now(),
    capabilities: [...PLUGIN_CAPABILITIES],
  });
}

function readSessionStore(cfg: unknown): string | undefined {
  if (typeof cfg !== 'object' || cfg === null) return undefined;
  if (!('session' in cfg)) return undefined;
  const session = cfg.session;
  if (typeof session !== 'object' || session === null) return undefined;
  if (!('store' in session)) return undefined;
  const store = session.store;
  return typeof store === 'string' ? store : undefined;
}

export async function dispatchInbound(
  api: OpenClawPluginApi,
  payload: KiloChatInboundPayload
): Promise<void> {
  const cfg = api.config;
  const channelRuntime = api.runtime.channel;

  // accountId: the SDK type requires a non-nullable string; this is a single-account
  // plugin so there is no meaningful account to scope to — use '' as the default.
  const { route, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
    cfg,
    channel: 'kilo-chat',
    accountId: DEFAULT_ACCOUNT_ID,
    peer: { kind: 'direct' as const, id: payload.conversationId },
    runtime: {
      routing: { resolveAgentRoute: channelRuntime.routing.resolveAgentRoute },
      session: {
        resolveStorePath: channelRuntime.session.resolveStorePath,
        readSessionUpdatedAt: channelRuntime.session.readSessionUpdatedAt,
      },
      reply: {
        resolveEnvelopeFormatOptions: channelRuntime.reply.resolveEnvelopeFormatOptions,
        formatAgentEnvelope: channelRuntime.reply.formatAgentEnvelope,
      },
    },
    sessionStore: readSessionStore(cfg),
  });

  const { storePath, body } = buildEnvelope({
    channel: 'Kilo Chat',
    from: payload.from,
    timestamp: Date.parse(payload.sentAt),
    body: payload.text,
  });

  const client = createKiloChatClient({
    controllerBaseUrl: resolveControllerUrl(),
    gatewayToken: resolveGatewayToken(),
  });

  const { mediaPaths, mediaTypes, failedCount } = await downloadInboundAttachments({
    client,
    conversationId: payload.conversationId,
    attachments: payload.attachments ?? [],
    saveMediaBuffer: channelRuntime.media.saveMediaBuffer,
    fetchImpl: __dispatchInternals.fetchImpl,
  });

  const mediaFields: Record<string, string | string[] | undefined> = {};
  if (mediaPaths.length > 0) {
    mediaFields.MediaPath = mediaPaths[0];
    mediaFields.MediaType = mediaTypes[0];
    mediaFields.MediaPaths = mediaPaths;
    mediaFields.MediaTypes = mediaTypes;
  }

  // If the message has no text and every attachment download failed, the
  // agent would otherwise be invoked with an empty body and silently respond
  // to nothing. Inject a synthetic note so the bot can ask the user to
  // resend.
  const bodyForAgent =
    payload.text.length === 0 && mediaPaths.length === 0 && failedCount > 0
      ? `[system: ${failedCount} attachment(s) failed to download — ask the user to resend]`
      : payload.text;

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: bodyForAgent,
    RawBody: payload.text,
    CommandBody: payload.text,
    From: `kilo-chat:${payload.from}`,
    To: `kilo-chat:${payload.conversationId}`,
    SessionKey: route.sessionKey,
    AccountId: route.accountId,
    ChatType: 'direct',
    ConversationLabel: payload.conversationId,
    MessageSid: payload.messageId,
    MessageSidFull: payload.messageId,
    Provider: 'kilo-chat',
    Surface: 'kilo-chat',
    OriginatingChannel: 'kilo-chat',
    OriginatingTo: `kilo-chat:${payload.conversationId}`,
    ReplyToId: payload.inReplyToMessageId,
    ReplyToBody: payload.inReplyToBody,
    ReplyToSender: payload.inReplyToSender,
    ...mediaFields,
  });

  const wiring = buildDeliverWiring({
    client,
    conversationId: payload.conversationId,
    inReplyToMessageId: payload.messageId,
    warn: (msg, err) => console.warn(`[kilo-chat] ${msg}:`, err),
  });

  try {
    await channelRuntime.session.recordInboundSession({
      storePath,
      sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
      ctx: ctxPayload,
      onRecordError: err => console.error('[kilo-chat] recordInboundSession:', err),
    });

    const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
      cfg,
      agentId: route.agentId,
      channel: 'kilo-chat',
      accountId: DEFAULT_ACCOUNT_ID,
      typing: buildTypingParams({ client, conversationId: payload.conversationId }),
    });

    let selectedModel: { provider?: string; model?: string } | null = null;
    const onModelSelectedTap: typeof onModelSelected = ctx => {
      selectedModel = { provider: ctx.provider, model: ctx.model };
      onModelSelected?.(ctx);
    };

    const sessionKey = ctxPayload.SessionKey ?? route.sessionKey;
    const pushConversationStatus = () => {
      try {
        const usage = readSessionUsage({ storePath, sessionKey });
        const ctxFields = toContextPayload(usage, selectedModel);
        if (ctxFields.contextTokens == null || ctxFields.contextWindow == null) return;
        void client.sendConversationStatus({
          conversationId: payload.conversationId,
          contextTokens: ctxFields.contextTokens,
          contextWindow: ctxFields.contextWindow,
          model: ctxFields.model,
          provider: ctxFields.provider,
          at: Date.now(),
        });
      } catch (err) {
        console.warn('[kilo-chat] post-turn conversation-status failed:', err);
      }
    };

    const deliver = createNormalizedOutboundDeliverer(wiring.deliver);

    await channelRuntime.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        ...replyPipeline,
        deliver,
        onError: (err, info) => console.error(`[kilo-chat] dispatchReply (${info.kind}):`, err),
      },
      replyOptions: {
        ...wiring.replyOptions,
        onModelSelected: onModelSelectedTap,
        disableBlockStreaming: false,
      },
    });
    await wiring.finalize();
    pushConversationStatus();
  } catch (err) {
    try {
      await wiring.finalize(err);
    } catch {
      // best-effort cleanup; do not let finalize errors mask the original dispatch error
    }
    throw err;
  }
}
