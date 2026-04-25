import type { z } from 'zod';
import type { ClientMessage, EventServiceConfig } from './types';
import {
  connectTicketResponseSchema,
  serverMessageSchema,
  type connectQuerySchema,
} from './schemas';

export class TicketRequestError extends Error {
  readonly status: number;
  constructor(status: number) {
    super(`Ticket request failed: ${status}`);
    this.name = 'TicketRequestError';
    this.status = status;
  }
}

export class HandshakeTimeoutError extends Error {
  constructor() {
    super('WebSocket handshake timed out');
    this.name = 'HandshakeTimeoutError';
  }
}

const HANDSHAKE_TIMEOUT_MS = 10_000;

export class EventServiceClient {
  private readonly url: string;
  private readonly getToken: () => Promise<string>;
  private readonly onUnauthorized: (() => void) | undefined;

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
  private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  private abortHandshake: ((err: Error) => void) | null = null;

  constructor(config: EventServiceConfig) {
    this.url = config.url;
    this.getToken = config.getToken;
    this.onUnauthorized = config.onUnauthorized;
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
    } catch (err) {
      if (this.handleAuthFailure(err)) return;
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    }
  }

  private handleAuthFailure(err: unknown): boolean {
    if (err instanceof TicketRequestError && (err.status === 401 || err.status === 403)) {
      this.destroyed = true;
      if (this.reconnectTimer !== null) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
      this.onUnauthorized?.();
      return true;
    }
    return false;
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
      throw new TicketRequestError(res.status);
    }
    const { ticket, userId } = connectTicketResponseSchema.parse(await res.json());

    // Step 2: Connect WebSocket using the ticket
    const query: z.input<typeof connectQuerySchema> = { ticket, userId };
    const qs = new URLSearchParams({ ticket: query.ticket, userId: query.userId }).toString();
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(`${this.url}/connect?${qs}`);
      this.ws = ws;

      // Guard against double-resolution: the handshake timeout, the
      // WebSocket 'error' event, and disconnect() can all try to settle
      // this promise.
      let settled = false;
      const settleResolve = (): void => {
        if (settled) return;
        settled = true;
        this.clearHandshakeTimer();
        this.abortHandshake = null;
        resolve();
      };
      const settleReject = (err: Error): void => {
        if (settled) return;
        settled = true;
        this.clearHandshakeTimer();
        this.abortHandshake = null;
        reject(err);
      };
      this.abortHandshake = settleReject;

      this.handshakeTimer = setTimeout(() => {
        this.handshakeTimer = null;
        if (this.ws === ws) {
          // Close the stalled socket. The 'close' listener will fire and
          // call scheduleReconnect(); scheduleReconnect() guards against
          // double-scheduling, so the reject path below is safe.
          ws.close(1000, 'handshake-timeout');
        }
        settleReject(new HandshakeTimeoutError());
      }, HANDSHAKE_TIMEOUT_MS);

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
        settleResolve();
        this.startPing();
      });

      ws.addEventListener('message', (event: MessageEvent) => {
        this.handleMessage(event.data as string);
      });

      ws.addEventListener('close', () => {
        if (this.ws !== ws) return;
        this.connected = false;
        this.stopPing();
        this.clearHandshakeTimer();
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      });

      ws.addEventListener('error', () => {
        if (this.ws !== ws) return;
        // error is always followed by close, so we only need to reject the
        // connect promise here if we never opened.
        if (!this.connected) {
          settleReject(new Error('WebSocket connection failed'));
        }
      });
    });
  }

  private clearHandshakeTimer(): void {
    if (this.handshakeTimer !== null) {
      clearTimeout(this.handshakeTimer);
      this.handshakeTimer = null;
    }
  }

  disconnect(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.clearHandshakeTimer();
    // If a connect handshake is still in flight, reject it so callers
    // awaiting connect() don't hang forever.
    if (this.abortHandshake) {
      this.abortHandshake(new Error('disconnected'));
    }
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
    this.stopPing();
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected && this.ws !== null && this.ws.readyState === WebSocket.OPEN;
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
      if (handlers?.size === 0) {
        this.eventHandlers.delete(event);
      }
    };
  }

  private send(message: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(message));
    }
  }

  private handleMessage(data: string): void {
    if (data === 'pong') return;

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
      return;
    }

    if (message.type === 'error') {
      // Server reported a protocol-level error (e.g. too_many_contexts).
      // The server keeps the socket open so we stay subscribed to what fit;
      // log so consumers notice if they care.
      console.warn('[event-service] server error', message.code, { max: message.max });
    }
  }

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send('ping');
      }
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
    if (this.reconnectTimer !== null) return;
    const base = Math.min(30_000, 1000 * 2 ** this.reconnectAttempts);
    const delay = base * (0.5 + Math.random() * 0.5);
    this.reconnectAttempts++;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connectOnce().catch(err => {
        // connectOnce() may fail before a WebSocket is created (e.g. ticket
        // fetch failure), so onclose won't fire. Schedule another reconnect,
        // unless the failure is a permanent auth failure.
        if (this.handleAuthFailure(err)) return;
        if (!this.destroyed) {
          this.scheduleReconnect();
        }
      });
    }, delay);
  }
}
