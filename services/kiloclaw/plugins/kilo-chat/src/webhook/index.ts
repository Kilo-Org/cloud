// Thin HTTP handler factory for the `/plugins/kilo-chat/webhook` route.
// Reads and validates the inbound body, then acks quickly and processes the
// matching event (message.created / action.executed) in the background. Public
// re-exports for the rest of the plugin live at the bottom of this file.

import type { IncomingMessage, ServerResponse } from 'node:http';

import { z } from 'zod';
import type { OpenClawPluginApi } from 'openclaw/plugin-sdk/plugin-entry';

import { createKiloChatClient } from '../client.js';
import { resolveControllerUrl, resolveGatewayToken } from '../env.js';

import { BODY_TOO_LARGE, readBody } from './body.js';
import {
  chatWebhookInboundSchema,
  parseActionExecutedPayload,
  parseInboundPayload,
} from './schemas.js';
import { dispatchInbound, handleActionExecuted, handleBotStatusRequest } from './dispatch.js';

export type KiloChatWebhookDeps = {
  api: OpenClawPluginApi;
};

export function createKiloChatWebhookHandler(deps: KiloChatWebhookDeps) {
  return async (req: IncomingMessage, res: ServerResponse): Promise<boolean> => {
    const body = await readBody(req);
    if (body === BODY_TOO_LARGE) {
      res.statusCode = 413;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Payload too large' }));
      return true;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      res.statusCode = 400;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ error: 'Invalid JSON' }));
      return true;
    }

    const envelope = chatWebhookInboundSchema.safeParse(parsed);
    const rawType = z.object({ type: z.string() }).partial().safeParse(parsed);
    const type = envelope.success
      ? envelope.data.type
      : rawType.success
        ? rawType.data.type
        : undefined;

    // Ack quickly then process in the background. The client (kiloclaw) has a
    // short (~15s) timeout on webhook delivery; agent dispatch and approval
    // resolution can easily exceed that on a cold machine. If we awaited
    // completion before responding, the client would mark the message
    // "delivery failed" even when the bot actually processed it.
    if (type === 'bot.status_request') {
      ackAccepted(res);
      void handleBotStatusRequest().catch(err => {
        console.error('[kilo-chat] bot.status_request failed:', err);
      });
      return true;
    }

    if (type === 'action.executed') {
      const actionPayload = parseActionExecutedPayload(parsed);
      if (!actionPayload) {
        res.statusCode = 400;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ error: 'Invalid action payload' }));
        return true;
      }
      ackAccepted(res);
      void handleActionExecuted(deps.api, actionPayload).catch(err => {
        console.error('[kilo-chat] action.executed failed:', err);
        try {
          const client = createKiloChatClient({
            controllerBaseUrl: resolveControllerUrl(),
            gatewayToken: resolveGatewayToken(),
          });
          void client.reportActionDeliveryFailed({
            conversationId: actionPayload.conversationId,
            messageId: actionPayload.messageId,
            groupId: actionPayload.groupId,
            reason: err instanceof Error ? err.message : String(err),
          });
        } catch {
          // swallow — report is best-effort
        }
      });
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

    ackAccepted(res);
    void dispatchInbound(deps.api, payload).catch(err => {
      console.error('[kilo-chat] dispatch failed:', err);
      try {
        const client = createKiloChatClient({
          controllerBaseUrl: resolveControllerUrl(),
          gatewayToken: resolveGatewayToken(),
        });
        void client.reportMessageDeliveryFailed({
          conversationId: payload.conversationId,
          messageId: payload.messageId,
          reason: err instanceof Error ? err.message : String(err),
        });
      } catch {
        // swallow — report is best-effort
      }
    });
    return true;
  };
}

function ackAccepted(res: ServerResponse): void {
  res.statusCode = 202;
  res.setHeader('content-type', 'application/json');
  res.end('{}');
}

export {
  parseActionExecutedPayload,
  parseInboundPayload,
  type ActionExecutedPayload,
  type KiloChatInboundPayload,
} from './schemas.js';
export { buildDeliverWiring, type DeliverPayload, type DeliverWiring } from './deliver.js';
export { buildTypingParams } from './typing.js';
