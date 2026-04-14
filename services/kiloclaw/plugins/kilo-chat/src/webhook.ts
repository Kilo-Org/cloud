import type { IncomingMessage, ServerResponse } from 'node:http';

import { createChannelReplyPipeline } from 'openclaw/plugin-sdk/channel-reply-pipeline';
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from 'openclaw/plugin-sdk/inbound-envelope';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';
import { createNormalizedOutboundDeliverer } from 'openclaw/plugin-sdk/reply-payload';

import { createKiloChatClient, type KiloChatClient } from './client.js';
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
  return {
    conversationId: o.conversationId,
    from: o.from,
    text: o.text,
    messageId: o.messageId,
    sentAt: o.sentAt,
  };
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
  warn: (msg: string, err?: unknown) => void;
}): DeliverWiring {
  const stream = createPreviewStream({
    client: params.client,
    conversationId: params.conversationId,
    throttleMs: STREAM_THROTTLE_MS,
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
  onStartError: (err: unknown) => void;
} {
  return {
    start: () => params.client.sendTyping({ conversationId: params.conversationId }),
    onStartError: err => console.warn('[kilo-chat] typing start failed:', err),
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
  });

  const gatewayToken = process.env.OPENCLAW_GATEWAY_TOKEN;
  if (!gatewayToken) {
    throw new Error('kilo-chat: OPENCLAW_GATEWAY_TOKEN is required');
  }
  const client = createKiloChatClient({
    controllerBaseUrl: process.env.KILOCLAW_CONTROLLER_URL ?? 'http://127.0.0.1:18789',
    gatewayToken,
  });

  const wiring = buildDeliverWiring({
    client,
    conversationId: payload.conversationId,
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

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string));
  }
  return Buffer.concat(chunks).toString('utf8');
}

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createKiloChatWebhookHandler(deps: KiloChatWebhookDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const rawBody = await readBody(req);

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawBody);
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
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
