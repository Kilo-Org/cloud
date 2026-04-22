import type { IncomingMessage, ServerResponse } from 'node:http';

import { createChannelReplyPipeline } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from 'openclaw/plugin-sdk/inbound-envelope';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { createNormalizedOutboundDeliverer } from 'openclaw/plugin-sdk/reply-payload';

import { resolveApprovalOverGateway } from 'openclaw/plugin-sdk/approval-gateway-runtime';
import type { ExecApprovalDecision } from 'openclaw/plugin-sdk/approval-runtime';

import { createKiloChatClient, type KiloChatClient } from './client.js';
import { resolveControllerUrl, resolveGatewayToken } from './env.js';
import { createPreviewStream } from './preview-stream.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KiloChatInboundPayload = {
  conversationId: string;
  from: string;
  text: string;
  messageId: string;
  sentAt: string;
  inReplyToMessageId?: string;
  inReplyToBody?: string;
  inReplyToSender?: string;
};

export type KiloChatWebhookDeps = {
  api: OpenClawPluginApi;
};

// ---------------------------------------------------------------------------
// Payload parsing
// ---------------------------------------------------------------------------

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

export function parseInboundPayload(raw: unknown): KiloChatInboundPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.conversationId)) return null;
  if (!isNonEmptyString(o.from)) return null;
  if (!isNonEmptyString(o.text)) return null;
  if (!isNonEmptyString(o.messageId)) return null;
  if (!isNonEmptyString(o.sentAt)) return null;
  const inReplyToMessageId =
    typeof o.inReplyToMessageId === 'string' && o.inReplyToMessageId.length > 0
      ? o.inReplyToMessageId
      : undefined;
  const inReplyToBody =
    typeof o.inReplyToBody === 'string' && o.inReplyToBody.length > 0 ? o.inReplyToBody : undefined;
  const inReplyToSender =
    typeof o.inReplyToSender === 'string' && o.inReplyToSender.length > 0
      ? o.inReplyToSender
      : undefined;
  return {
    conversationId: o.conversationId,
    from: o.from,
    text: o.text,
    messageId: o.messageId,
    sentAt: o.sentAt,
    inReplyToMessageId,
    inReplyToBody,
    inReplyToSender,
  };
}

// ---------------------------------------------------------------------------
// Action-executed payload parsing
// ---------------------------------------------------------------------------

export type ActionExecutedPayload = {
  groupId: string;
  value: string;
  executedBy: string;
};

export function parseActionExecutedPayload(raw: unknown): ActionExecutedPayload | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const o = raw as Record<string, unknown>;
  if (!isNonEmptyString(o.groupId)) return null;
  if (!isNonEmptyString(o.value)) return null;
  if (!isNonEmptyString(o.executedBy)) return null;
  return {
    groupId: o.groupId,
    value: o.value,
    executedBy: o.executedBy,
  };
}

async function handleActionExecuted(
  api: OpenClawPluginApi,
  payload: ActionExecutedPayload
): Promise<void> {
  const decision = payload.value as ExecApprovalDecision;
  await resolveApprovalOverGateway({
    cfg: api.config,
    approvalId: payload.groupId,
    decision,
    senderId: payload.executedBy,
    clientDisplayName: 'Kilo Chat',
  });
}

// ---------------------------------------------------------------------------
// Deliver wiring
// ---------------------------------------------------------------------------

/**
 * Default coalescing window between outbound PATCH edits during streaming.
 * Not user-configurable: the plugin always streams, and 500ms is the product
 * default agreed with the external chat service.
 */
const STREAM_THROTTLE_MS = 500;

export type DeliverPayload = { text?: string };

export type DeliverWiring = {
  deliver: (payload: DeliverPayload) => Promise<void>;
  replyOptions: {
    onPartialReply: (payload: { text?: string }) => void | Promise<void>;
  };
  /** Cleanup hook — call after dispatch completes or throws. Pass the error if any. */
  finalize: (err?: unknown) => Promise<void>;
};

export function buildDeliverWiring(params: {
  client: KiloChatClient;
  conversationId: string;
  inReplyToMessageId?: string;
  warn: (msg: string, err?: unknown) => void;
}): DeliverWiring {
  const stream = createPreviewStream({
    client: params.client,
    conversationId: params.conversationId,
    throttleMs: STREAM_THROTTLE_MS,
    inReplyToMessageId: params.inReplyToMessageId,
    onWarn: params.warn,
  });
  let firstDelivered = false;

  return {
    replyOptions: {
      onPartialReply: async payload => {
        if (typeof payload.text === 'string' && payload.text.length > 0) {
          stream.update(payload.text);
        }
      },
    },
    deliver: async payload => {
      if (!payload.text) return;
      if (!firstDelivered) {
        firstDelivered = true;
        await stream.finalize(payload.text);
        return;
      }
      // Subsequent blocks: plain create.
      await params.client.createMessage({
        conversationId: params.conversationId,
        content: [{ type: 'text', text: payload.text }],
      });
    },
    finalize: async err => {
      // Abort the preview only when dispatch errored or nothing was delivered
      // (both indicate the preview should NOT remain visible). A successful
      // first delivery finalized the stream, so abort would be a no-op anyway.
      if (err !== undefined || !firstDelivered) {
        await stream.abort(err);
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Typing params
// ---------------------------------------------------------------------------

export function buildTypingParams(params: { client: KiloChatClient; conversationId: string }): {
  start: () => Promise<void>;
  stop: () => Promise<void>;
  onStartError: (err: unknown) => void;
  onStopError: (err: unknown) => void;
} {
  return {
    start: () => params.client.sendTyping({ conversationId: params.conversationId }),
    stop: () => params.client.sendTypingStop({ conversationId: params.conversationId }),
    onStartError: err => console.warn('[kilo-chat] typing start failed:', err),
    onStopError: err => console.warn('[kilo-chat] typing stop failed:', err),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function dispatchInbound(
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
    accountId: '',
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
    sessionStore: (cfg as { session?: { store?: string } }).session?.store,
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
    warn: (msg, err) => console.error(`[kilo-chat] ${msg}:`, err),
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
      accountId: '',
      typing: buildTypingParams({ client, conversationId: payload.conversationId }),
    });

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
        onModelSelected,
      },
    });
    await wiring.finalize();
  } catch (err) {
    try {
      await wiring.finalize(err);
    } catch {
      // best-effort cleanup; do not let finalize errors mask the original dispatch error
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// HTTP body reader
// ---------------------------------------------------------------------------

/** Max accepted inbound webhook body. Messages are small — 1 MB is already generous. */
const MAX_WEBHOOK_BODY_BYTES = 1 * 1024 * 1024;

/**
 * Sentinel returned by readBody when the stream exceeds the cap. Using a
 * sentinel (rather than a thrown error) keeps the success path obvious and
 * lets the caller respond with 413 without an instanceof dance.
 */
const BODY_TOO_LARGE = Symbol('body-too-large');

async function readBody(req: IncomingMessage): Promise<string | typeof BODY_TOO_LARGE> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    total += buf.length;
    if (total > MAX_WEBHOOK_BODY_BYTES) return BODY_TOO_LARGE;
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createKiloChatWebhookHandler(deps: KiloChatWebhookDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const body = await readBody(req);
    if (body === BODY_TOO_LARGE) {
      res.statusCode = 413;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return true;
    }
    const rawBody = body;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }

    const type = (parsed as { type?: string }).type;

    if (type === 'action.executed') {
      // Resolve an approval via a button click in kilo-chat.
      const actionPayload = parseActionExecutedPayload(parsed);
      if (!actionPayload) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Invalid action payload' }));
        return true;
      }
      try {
        await handleActionExecuted(deps.api, actionPayload);
      } catch (err) {
        console.error('[kilo-chat] action.executed failed:', err);
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Action execution failed' }));
        return true;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end('{}');
      return true;
    }

    // Default: treat as message.created (for backwards compat, also accept
    // payloads without a type field).
    if (type !== undefined && type !== 'message.created') {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Unknown webhook type' }));
      return true;
    }

    const payload = parseInboundPayload(parsed);
    if (!payload) {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid payload' }));
      return true;
    }

    try {
      await dispatchInbound(deps.api, payload);
    } catch (err) {
      console.error('[kilo-chat] dispatch failed:', err);
      res.statusCode = 500;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Dispatch failed' }));
      return true;
    }

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end('{}');
    return true;
  };
}
