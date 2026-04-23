import { z } from 'zod';
import type { ClientMessage, EventServiceConfig, ServerMessage } from './types';

const serverMessageSchema: z.ZodType<ServerMessage> = z.object({
  type: z.literal('event'),
  context: z.string(),
  event: z.string(),
  payload: z.unknown(),
});

export class EventServiceClient {
  private readonly url: string;
  private readonly getToken: () => Promise<string>;

  private ws: WebSocket | null = null;
  private connected = false;
  private eventHandlers = new Map<string, Set<(context: string, payload: unknown) => void>>();
  private activeContexts = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private reconnectAttempts = 0;
  private hasConnectedBefore = false;
  private reconnectHandlers = new Set<() => void>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: EventServiceConfig) {
    this.url = config.url;
    this.getToken = config.getToken;
  }

  async connect(): Promise<void> {
    this.destroyed = false;
    this.reconnectAttempts = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.connectOnce();
    } catch {
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    }
  }

  private async connectOnce(): Promise<void> {
    // Close any existing socket to avoid leaking connections
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.close();
    }

    // Step 1: Exchange JWT for a single-use connection ticket
    const token = await this.getToken();
    const httpUrl = this.url.replace(/^ws(s?):\/\//, 'http$1://');
    const res = await fetch(`${httpUrl}/connect/ticket`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) {
      throw new Error(`Ticket request failed: ${res.status}`);
    }
    const { ticket, userId } = (await res.json()) as { ticket: string; userId: string };

    // Step 2: Connect WebSocket using the ticket
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(
        `${this.url}/connect?ticket=${encodeURIComponent(ticket)}&userId=${encodeURIComponent(userId)}`
      );
      this.ws = ws;

      ws.addEventListener('open', () => {
        const isReconnect = this.hasConnectedBefore;
        this.connected = true;
        this.hasConnectedBefore = true;
        this.reconnectAttempts = 0;
        this.resubscribeContexts();
        if (isReconnect) {
          for (const handler of this.reconnectHandlers) {
            handler();
          }
        }
        resolve();
        this.startPing();
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      });

      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.stopPing();
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      });

      ws.addEventListener('error', () => {
        if (this.ws !== ws) return;
        // error is always followed by close, so we only need to reject the
        // connect promise here if we never opened.
        if (!this.connected) {
          reject(new Error('WebSocket connection failed'));
        }
      });
    });
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.stopPing();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === 1;
  }

  subscribe(contexts: string[]): void {
    for (const ctx of contexts) {
      this.activeContexts.add(ctx);
    }
    if (this.isConnected()) {
      this.send({ type: 'context.subscribe', contexts });
    }
  }

  unsubscribe(contexts: string[]): void {
    for (const ctx of contexts) {
      this.activeContexts.delete(ctx);
    }
    if (this.isConnected()) {
      this.send({ type: 'context.unsubscribe', contexts });
    }
  }

  onReconnect(handler: () => void): () => void {
    this.reconnectHandlers.add(handler);
    return () => {
      this.reconnectHandlers.delete(handler);
    };
  }

  on(event: string, handler: (context: string, payload: unknown) => void): () => void {
    let handlers = this.eventHandlers.get(event);
    if (!handlers) {
      handlers = new Set();
      this.eventHandlers.set(event, handlers);
    }
    handlers.add(handler);
    return () => {
      handlers?.delete(handler);
    };
  }

  private send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(data: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const result = serverMessageSchema.safeParse(parsed);
    if (!result.success) return;
    const message = result.data;

    if (message.type === 'event') {
      const handlers = this.eventHandlers.get(message.event);
      if (handlers) {
        for (const handler of handlers) {
          handler(message.context, message.payload);
        }
      }
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: 'presence.ping' });
    }, 15000);
  }

  private stopPing(): void {
    if (this.pingTimer !== null) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private resubscribeContexts(): void {
    if (this.activeContexts.size > 0) {
      this.send({
        type: 'context.subscribe',
        contexts: Array.from(this.activeContexts),
      });
    }
  }

  private scheduleReconnect(): void {
    const base = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectOnce().catch(() => {
        // connectOnce() may fail before a WebSocket is created (e.g. ticket
        // fetch failure), so onclose won't fire. Schedule another reconnect.
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }
}
