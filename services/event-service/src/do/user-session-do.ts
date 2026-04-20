import { DurableObject } from 'cloudflare:workers';
import type { ClientMessage, ServerMessage } from '../types';

type SerializedState = { contexts: string[] };

export class UserSessionDO extends DurableObject<Env> {
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

    let msg: ClientMessage;
    try {
      msg = JSON.parse(rawMessage) as ClientMessage;
    } catch {
      return;
    }

    switch (msg.type) {
      case 'context.subscribe': {
        const state = this.getState(ws);
        for (const ctx of msg.contexts) state.contexts.add(ctx);
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

  async webSocketClose(
    _ws: WebSocket,
    _code: number,
    _reason: string,
    _wasClean: boolean
  ): Promise<void> {
    // Hibernation API handles cleanup automatically
  }

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

  // ── Helpers ────────────────────────────────────────────────────────

  private getState(ws: WebSocket): { contexts: Set<string> } {
    const raw = ws.deserializeAttachment() as SerializedState | null;
    return { contexts: new Set(raw?.contexts ?? []) };
  }

  private saveState(ws: WebSocket, state: { contexts: Set<string> }): void {
    ws.serializeAttachment({ contexts: [...state.contexts] } satisfies SerializedState);
  }
}
