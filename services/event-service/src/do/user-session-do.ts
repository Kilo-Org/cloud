import { DurableObject } from 'cloudflare:workers';
import { z } from 'zod';
import type { ServerMessage } from '../types';

const MAX_CONTEXTS_PER_MESSAGE = 100;
const MAX_CONTEXTS_PER_SOCKET = 200;
const MAX_CONTEXT_LENGTH = 256;

const contextSchema = z.string().min(1).max(MAX_CONTEXT_LENGTH);
const clientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('context.subscribe'),
    contexts: z.array(contextSchema).max(MAX_CONTEXTS_PER_MESSAGE),
  }),
  z.object({
    type: z.literal('context.unsubscribe'),
    contexts: z.array(contextSchema).max(MAX_CONTEXTS_PER_MESSAGE),
  }),
]);

type SerializedState = { contexts: string[] };

export class UserSessionDO extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ contexts: [] } satisfies SerializedState);

    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, rawMessage: string | ArrayBuffer): Promise<void> {
    if (typeof rawMessage !== 'string') return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(rawMessage);
    } catch {
      return;
    }

    const result = clientMessageSchema.safeParse(parsed);
    if (!result.success) return;
    const msg = result.data;

    switch (msg.type) {
      case 'context.subscribe': {
        const state = this.getState(ws);
        for (const ctx of msg.contexts) {
          state.contexts.add(ctx);
          if (state.contexts.size > MAX_CONTEXTS_PER_SOCKET) {
            ws.close(1008, 'Too many contexts');
            return;
          }
        }
        this.saveState(ws, state);
        break;
      }
      case 'context.unsubscribe': {
        const state = this.getState(ws);
        for (const ctx of msg.contexts) state.contexts.delete(ctx);
        this.saveState(ws, state);
        break;
      }
    }
  }

  // Required by the hibernation API: workerd calls webSocketClose on any
  // accepted WebSocket. The hibernation runtime handles attachment cleanup,
  // so there is nothing to do here.
  async webSocketClose(): Promise<void> {}

  async webSocketError(ws: WebSocket): Promise<void> {
    ws.close(1011, 'WebSocket error');
  }

  // ── Event push ─────────────────────────────────────────────────────

  async pushEvent(context: string, event: string, payload: unknown): Promise<void> {
    const sockets = this.ctx.getWebSockets();
    const message: ServerMessage = { type: 'event', context, event, payload };
    const text = JSON.stringify(message);

    for (const ws of sockets) {
      const state = this.getState(ws);
      if (state.contexts.has(context)) {
        try {
          ws.send(text);
        } catch {
          // Connection dead — hibernation will clean up
        }
      }
    }
  }

  // ── Presence ───────────────────────────────────────────────────────

  async isUserInContext(context: string): Promise<boolean> {
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.getState(ws);
      if (state.contexts.has(context)) return true;
    }
    return false;
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private getState(ws: WebSocket): { contexts: Set<string> } {
    const raw = ws.deserializeAttachment() as SerializedState | null;
    return { contexts: new Set(raw?.contexts ?? []) };
  }

  private saveState(ws: WebSocket, state: { contexts: Set<string> }): void {
    ws.serializeAttachment({
      contexts: [...state.contexts],
    } satisfies SerializedState);
  }
}
