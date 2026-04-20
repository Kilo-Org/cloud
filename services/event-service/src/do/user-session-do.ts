import { DurableObject } from 'cloudflare:workers';
import type { ClientMessage, ServerMessage } from '../types';

type SerializedState = { contexts: string[]; userId: string };

export class UserSessionDO extends DurableObject<Env> {
  async fetch(request: Request): Promise<Response> {
    const upgradeHeader = request.headers.get('Upgrade');
    if (upgradeHeader !== 'websocket') {
      return new Response('Expected WebSocket upgrade', { status: 426 });
    }

    const url = new URL(request.url);
    const userId = url.searchParams.get('userId') ?? '';

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ contexts: [], userId } satisfies SerializedState);

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
      case 'presence.ping': {
        await this.setLastPingAt(Date.now());
        break;
      }
      case 'presence.show': {
        const added = await this.setVisible(msg.context);
        if (added) {
          const state = this.getState(ws);
          this.broadcastPresence('presence.joined', ws, msg.context, state.userId);
        }
        break;
      }
      case 'presence.hide': {
        const removed = await this.clearVisible(msg.context);
        if (removed) {
          const state = this.getState(ws);
          this.broadcastPresence('presence.left', ws, msg.context, state.userId);
        }
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

  // ── Presence check ─────────────────────────────────────────────────

  async isUserInContext(context: string): Promise<boolean> {
    for (const ws of this.ctx.getWebSockets()) {
      const state = this.getState(ws);
      if (state.contexts.has(context)) return true;
    }
    return false;
  }

  // ── DO storage helpers (presence) ──────────────────────────────────

  private async setLastPingAt(now: number): Promise<void> {
    await this.ctx.storage.put('presence:lastPingAt', now);
  }

  async getLastPingAt(): Promise<number> {
    return (await this.ctx.storage.get<number>('presence:lastPingAt')) ?? 0;
  }

  private async setVisible(context: string): Promise<boolean> {
    const key = `presence:visible:${context}`;
    const already = await this.ctx.storage.get<true>(key);
    if (already) return false;
    await this.ctx.storage.put(key, true);
    return true;
  }

  private async clearVisible(context: string): Promise<boolean> {
    const key = `presence:visible:${context}`;
    const was = await this.ctx.storage.get<true>(key);
    if (!was) return false;
    await this.ctx.storage.delete(key);
    return true;
  }

  // ── Broadcast helpers ──────────────────────────────────────────────

  private broadcastPresence(
    type: 'presence.joined' | 'presence.left',
    sender: WebSocket,
    context: string,
    userId: string
  ): void {
    const msg: ServerMessage = { type, context, userId };
    const text = JSON.stringify(msg);
    for (const ws of this.ctx.getWebSockets()) {
      if (ws === sender) continue;
      const state = this.getState(ws);
      if (state.contexts.has(context)) {
        try {
          ws.send(text);
        } catch {
          /* dead connection */
        }
      }
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────

  private getState(ws: WebSocket): { contexts: Set<string>; userId: string } {
    const raw = ws.deserializeAttachment() as SerializedState | null;
    return { contexts: new Set(raw?.contexts ?? []), userId: raw?.userId ?? '' };
  }

  private saveState(ws: WebSocket, state: { contexts: Set<string>; userId: string }): void {
    ws.serializeAttachment({
      contexts: [...state.contexts],
      userId: state.userId,
    } satisfies SerializedState);
  }
}
