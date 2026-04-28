// Event dispatch for inbound Kilo Chat webhooks. Bridges the validated payload
// into OpenClaw's channel reply pipeline (for message.created) or the approval
// gateway resolver (for action.executed).

import { createChannelReplyPipeline } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from 'openclaw/plugin-sdk/inbound-envelope';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { createNormalizedOutboundDeliverer } from 'openclaw/plugin-sdk/reply-payload';
import { resolveApprovalOverGateway } from 'openclaw/plugin-sdk/approval-gateway-runtime';

import { createKiloChatClient } from '../client.js';
import { resolveControllerUrl, resolveGatewayToken } from '../env.js';
import { DEFAULT_ACCOUNT_ID } from '../channel.js';
import { readSessionUsage, toContextPayload } from '../bot-status.js';

import { buildDeliverWiring } from './deliver.js';
import { buildTypingParams } from './typing.js';
import type { ActionExecutedPayload, KiloChatInboundPayload } from './schemas.js';

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

  const ctxPayload = channelRuntime.reply.finalizeInboundContext({
    Body: body,
    BodyForAgent: payload.text,
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
  });

  const client = createKiloChatClient({
    controllerBaseUrl: resolveControllerUrl(),
    gatewayToken: resolveGatewayToken(),
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
