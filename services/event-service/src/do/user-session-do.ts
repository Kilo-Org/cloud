import { DurableObject } from 'cloudflare:workers';
import { clientMessageSchema, MAX_CONTEXTS } from '@kilocode/event-service';
import { logger, withLogTags } from '../util/logger';
import type { ServerMessage } from '../types';

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
        let overflowed = false;
        for (const ctx of msg.contexts) {
          if (state.contexts.size >= MAX_CONTEXTS && !state.contexts.has(ctx)) {
            overflowed = true;
            continue;
          }
          state.contexts.add(ctx);
        }
        this.saveState(ws, state);
        if (overflowed) {
          const errorMsg: ServerMessage = {
            type: 'error',
            code: 'too_many_contexts',
            max: MAX_CONTEXTS,
          };
          try {
            ws.send(JSON.stringify(errorMsg));
          } catch {
            // Connection dead — hibernation will clean up
          }
        }
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

  async pushEvent<Name extends string>(
    context: string,
    event: Name,
    payload: unknown
  ): Promise<boolean> {
    return withLogTags({ source: 'UserSessionDO.pushEvent' }, () => {
      logger.setTags({ userId: this.ctx.id.name, context, event });

      const sockets = this.ctx.getWebSockets();
      const message: ServerMessage = { type: 'event', context, event, payload };
      const text = JSON.stringify(message);
      let delivered = false;

      for (const ws of sockets) {
        const state = this.getState(ws);
        if (!state.contexts.has(context)) continue;
        try {
          ws.send(text);
          delivered = true;
        } catch {
          // Connection dead — hibernation will clean up
        }
      }
      return delivered;
    });
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
