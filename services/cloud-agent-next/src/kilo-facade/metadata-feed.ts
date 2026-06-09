import {
  sessionUpdatedMetadataMessageSchema,
  type SessionUpdatedMetadataMessage,
} from '@kilocode/session-ingest-contracts';
import type { Env } from '../types.js';

const INITIAL_RECONNECT_DELAY_MS = 250;
const MAX_RECONNECT_DELAY_MS = 4_000;
const RECONNECT_STABILITY_MS = 10_000;

type MetadataFeedCallbacks = {
  onMessage(message: SessionUpdatedMetadataMessage, generation: number): void;
  onConnected(generation: number): void;
  onStopped(): void;
};

type SocketListeners = {
  message: EventListener;
  close: EventListener;
  error: EventListener;
};

type MetadataDemand = {
  generation: number;
  started: boolean;
};

export class FacadeMetadataFeed {
  private demand = 0;
  private generation = 0;
  private userId?: string;
  private connectionId?: string;
  private socket?: WebSocket;
  private listeners?: SocketListeners;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private stabilityTimer?: ReturnType<typeof setTimeout>;
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;

  constructor(
    private readonly env: Env,
    private readonly callbacks: MetadataFeedCallbacks
  ) {}

  addDemand(userId: string): MetadataDemand {
    this.demand += 1;
    if (this.demand !== 1) return { generation: this.generation, started: false };
    this.userId = userId;
    this.connectionId = `facade-${crypto.randomUUID()}`;
    this.generation += 1;
    void this.connect(this.generation);
    return { generation: this.generation, started: true };
  }

  removeDemand(): void {
    if (this.demand === 0) return;
    this.demand -= 1;
    if (this.demand > 0) return;
    this.stop();
  }

  isCurrent(generation: number): boolean {
    return this.demand > 0 && this.generation === generation;
  }

  userIdForCurrentDemand(): string {
    return this.userId ?? '';
  }

  private async connect(generation: number): Promise<void> {
    const userId = this.userId;
    const connectionId = this.connectionId;
    if (!userId || !connectionId || !this.isCurrent(generation)) return;
    try {
      const secret = await this.env.INTERNAL_API_SECRET_PROD.get();
      if (!this.isCurrent(generation)) return;
      const response = await this.env.SESSION_INGEST.fetch(
        `https://session-ingest/internal/user/events?connectionId=${encodeURIComponent(connectionId)}`,
        {
          headers: {
            Upgrade: 'websocket',
            'X-Internal-Secret': secret,
            'X-Kilo-User-Id': userId,
          },
        }
      );
      if (!this.isCurrent(generation)) {
        response.webSocket?.close(1000, 'Facade metadata demand ended');
        return;
      }
      if (response.status !== 101 || !response.webSocket) {
        response.webSocket?.close(1002, 'Session metadata upgrade failed');
        this.scheduleReconnect(generation);
        return;
      }
      const socket = response.webSocket;
      socket.accept();
      const message: EventListener = event => {
        if (!this.isCurrent(generation) || !(event instanceof MessageEvent)) return;
        if (typeof event.data !== 'string') return;
        try {
          const parsed = sessionUpdatedMetadataMessageSchema.safeParse(JSON.parse(event.data));
          if (parsed.success) this.callbacks.onMessage(parsed.data, generation);
        } catch {
          // Malformed metadata is non-fatal and ignored.
        }
      };
      const disconnected: EventListener = () => {
        if (!this.isCurrent(generation) || this.socket !== socket) return;
        this.detachSocket();
        socket.close(1001, 'Session metadata connection ended');
        this.scheduleReconnect(generation);
      };
      this.socket = socket;
      this.listeners = { message, close: disconnected, error: disconnected };
      socket.addEventListener('message', message);
      socket.addEventListener('close', disconnected);
      socket.addEventListener('error', disconnected);
      this.stabilityTimer = setTimeout(() => {
        this.stabilityTimer = undefined;
        if (this.isCurrent(generation) && this.socket === socket) {
          this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
        }
      }, RECONNECT_STABILITY_MS);
      this.callbacks.onConnected(generation);
    } catch {
      if (this.isCurrent(generation)) this.scheduleReconnect(generation);
    }
  }

  private scheduleReconnect(generation: number): void {
    if (!this.isCurrent(generation) || this.retryTimer) return;
    const delay = this.reconnectDelayMs;
    this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = undefined;
      void this.connect(generation);
    }, delay);
  }

  private detachSocket(): void {
    if (this.stabilityTimer) clearTimeout(this.stabilityTimer);
    this.stabilityTimer = undefined;
    const socket = this.socket;
    const listeners = this.listeners;
    if (socket && listeners) {
      socket.removeEventListener('message', listeners.message);
      socket.removeEventListener('close', listeners.close);
      socket.removeEventListener('error', listeners.error);
    }
    this.socket = undefined;
    this.listeners = undefined;
  }

  private stop(): void {
    this.generation += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    const socket = this.socket;
    this.detachSocket();
    socket?.close(1000, 'Facade metadata demand ended');
    this.userId = undefined;
    this.connectionId = undefined;
    this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS;
    this.callbacks.onStopped();
  }
}
