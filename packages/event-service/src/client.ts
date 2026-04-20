import type { ClientMessage, EventServiceConfig, ServerMessage } from './types';

export class EventServiceClient {
  private readonly url: string;
  private readonly getToken: () => Promise<string>;

  private ws: WebSocket | null = null;
  private connected = false;
  private eventHandlers = new Map<string, Set<(context: string, payload: unknown) => void>>();
  private activeContexts = new Set<string>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;

  constructor(config: EventServiceConfig) {
    this.url = config.url;
    this.getToken = config.getToken;
  }

  async connect(): Promise<void> {
    // Step 1: Exchange JWT for a single-use connection ticket
    const token = await this.getToken();
    const res = await fetch(`${this.url}/connect/ticket`, {
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

      ws.onopen = () => {
        this.connected = true;
        this.resubscribeContexts();
        resolve();
      };

      ws.onmessage = (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      };

      ws.onclose = () => {
        this.connected = false;
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      };

      ws.onerror = () => {
        // onerror is always followed by onclose, so we only need to reject the
        // connect promise here if we never opened.
        if (!this.connected) {
          reject(new Error('WebSocket connection failed'));
        }
      };
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
    let message: ServerMessage;
    try {
      message = JSON.parse(data) as ServerMessage;
    } catch {
      return;
    }

    if (message.type === 'event') {
      const handlers = this.eventHandlers.get(message.event);
      if (handlers) {
        for (const handler of handlers) {
          handler(message.context, message.payload);
        }
      }
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
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // will retry again via onclose
      });
    }, 3000);
  }
}
