import type { ClientMessage, ConnectTicketQuery, EventServiceConfig } from './types';
import { connectTicketResponseSchema, serverMessageSchema } from './schemas';

const WEBSOCKET_PROTOCOL = 'kilo.events.v1';

/**
 * Thrown (and surfaced via {@link EventServiceConfig.onUnauthorized}) when the
 * Event Service rejects connection-ticket minting with 401/403. Browsers do not
 * expose the HTTP status of a failed WebSocket handshake, so pre-open socket
 * errors are treated as generic reconnectable failures.
 */
export class WebSocketAuthError extends Error {
  constructor(message = 'WebSocket authentication failed') {
    super(message);
    this.name = 'WebSocketAuthError';
  }
}

export class HandshakeTimeoutError extends Error {
  constructor() {
    super('WebSocket handshake timed out');
    this.name = 'HandshakeTimeoutError';
  }
}

const HANDSHAKE_TIMEOUT_MS = 10_000;
const MAX_AUTH_RECOVERY_ATTEMPTS = 1;

function baseUrlWithPath(base: string, path: string): URL {
  return new URL(path, base.endsWith('/') ? base : `${base}/`);
}

function ticketEndpointFor(wsBase: string): string {
  const url = baseUrlWithPath(wsBase, 'connect-ticket');
  if (url.protocol === 'ws:') {
    url.protocol = 'http:';
  } else if (url.protocol === 'wss:') {
    url.protocol = 'https:';
  }
  return url.toString();
}

function connectUrlFor(wsBase: string, ticket: string): string {
  const url = baseUrlWithPath(wsBase, 'connect');
  const query = { ticket } satisfies ConnectTicketQuery;
  url.searchParams.set('ticket', query.ticket);
  return url.toString();
}

async function fetchConnectionTicket(wsBase: string, token: string): Promise<string> {
  const response = await fetch(ticketEndpointFor(wsBase), {
    method: 'POST',
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 401 || response.status === 403) {
    throw new WebSocketAuthError();
  }
  if (!response.ok) {
    throw new Error('Failed to mint WebSocket connection ticket');
  }

  const body = connectTicketResponseSchema.parse(await response.json());
  return body.ticket;
}

export class EventServiceClient {
  private readonly url: string;
  private readonly getToken: () => Promise<string>;
  private readonly onUnauthorized: EventServiceConfig['onUnauthorized'];

  private ws: WebSocket | null = null;
  private connected = false;
  private eventHandlers = new Map<string, Set<(context: string, payload: unknown) => void>>();
  // Refcounted so multiple consumers can independently subscribe to and
  // unsubscribe from the same context without trampling each other. The wire
  // `context.subscribe`/`context.unsubscribe` messages are only sent on the
  // 0↔1 transitions; intermediate refcount churn stays client-side.
  private activeContexts = new Map<string, number>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private destroyed = false;
  private reconnectAttempts = 0;
  private authRecoveryAttempts = 0;
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
    this.authRecoveryAttempts = 0;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    try {
      await this.connectOnce();
    } catch (err) {
      if (await this.handleAuthFailure(err)) return;
      if (!this.destroyed) {
        this.scheduleReconnect();
      }
    }
  }

  private async handleAuthFailure(err: unknown): Promise<boolean> {
    if (!(err instanceof WebSocketAuthError) || !this.onUnauthorized) {
      return false;
    }

    if (this.authRecoveryAttempts >= MAX_AUTH_RECOVERY_ATTEMPTS) {
      this.stopAfterUnauthorized();
      return true;
    }

    const decision = await this.onUnauthorized();
    if (decision === 'stop' || this.destroyed) {
      this.stopAfterUnauthorized();
      return true;
    }

    this.authRecoveryAttempts++;
    this.scheduleReconnect();
    return true;
  }

  private stopAfterUnauthorized(): void {
    this.destroyed = true;
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private async connectOnce(): Promise<void> {
    // Close any existing socket to avoid leaking connections.
    if (this.ws) {
      const oldWs = this.ws;
      this.ws = null;
      oldWs.close();
    }

    const token = await this.getToken();
    if (this.destroyed) return;
    const ticket = await fetchConnectionTicket(this.url, token);
    // disconnect() may have run while we were awaiting the token. Bail before
    // creating the socket so we don't leak a WebSocket + ping timer past
    // provider unmount (e.g. sign-out, navigation, strict-mode remount).
    if (this.destroyed) return;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(connectUrlFor(this.url, ticket), [WEBSOCKET_PROTOCOL]);
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
        this.authRecoveryAttempts = 0;
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
        // connect promise here if we never opened. The browser does not expose
        // the HTTP status of a failed upgrade, so reconnect and reserve auth
        // recovery for the preceding connection-ticket HTTP request.
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
    const newlyActive: string[] = [];
    for (const ctx of contexts) {
      const next = (this.activeContexts.get(ctx) ?? 0) + 1;
      this.activeContexts.set(ctx, next);
      if (next === 1) newlyActive.push(ctx);
    }
    if (newlyActive.length > 0 && this.isConnected()) {
      const message = {
        type: 'context.subscribe',
        contexts: newlyActive,
      } satisfies ClientMessage;
      this.send(message);
    }
  }

  unsubscribe(contexts: string[]): void {
    const released: string[] = [];
    for (const ctx of contexts) {
      const current = this.activeContexts.get(ctx);
      if (current === undefined) continue;
      if (current <= 1) {
        this.activeContexts.delete(ctx);
        released.push(ctx);
      } else {
        this.activeContexts.set(ctx, current - 1);
      }
    }
    if (released.length > 0 && this.isConnected()) {
      const message = {
        type: 'context.unsubscribe',
        contexts: released,
      } satisfies ClientMessage;
      this.send(message);
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
      const message = {
        type: 'context.subscribe',
        contexts: Array.from(this.activeContexts.keys()),
      } satisfies ClientMessage;
      this.send(message);
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
        void this.handleReconnectFailure(err);
      });
    }, delay);
  }

  private async handleReconnectFailure(err: unknown): Promise<void> {
    if (await this.handleAuthFailure(err)) return;
    if (!this.destroyed) {
      this.scheduleReconnect();
    }
  }
}
