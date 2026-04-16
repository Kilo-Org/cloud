import type { KiloChatConfig, SSEEventHandler } from './types';

export class KiloChatSSE {
  private baseUrl: string;
  private getToken: () => Promise<string>;
  private fetchFn: typeof globalThis.fetch;
  private abortController: AbortController | null = null;
  private connected = false;
  private lastEventId: string | null = null;

  constructor(config: KiloChatConfig) {
    this.baseUrl = config.baseUrl;
    this.getToken = config.getToken;
    this.fetchFn = config.fetch ?? globalThis.fetch;
  }

  connect(conversationId: string, handlers: SSEEventHandler): void {
    this.disconnect();
    this.connected = true;
    this.abortController = new AbortController();
    void this.connectLoop(conversationId, handlers);
  }

  disconnect(): void {
    this.connected = false;
    this.abortController?.abort();
    this.abortController = null;
    this.lastEventId = null;
  }

  isConnected(): boolean {
    return this.connected;
  }

  private async connectLoop(conversationId: string, handlers: SSEEventHandler): Promise<void> {
    while (this.connected) {
      try {
        const token = await this.getToken();
        const url = `${this.baseUrl}/v1/conversations/${conversationId}/events`;
        const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
        if (this.lastEventId) headers['Last-Event-ID'] = this.lastEventId;

        const res = await this.fetchFn(url, {
          headers,
          signal: this.abortController?.signal,
        });

        if (!res.ok || !res.body) {
          if (!this.connected) return;
          await this.delay(3000);
          continue;
        }

        const reader = (res.body as ReadableStream<Uint8Array>).getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let currentEvent = '';
        let currentData = '';
        let currentId = '';

        while (this.connected) {
          const { done, value } = await reader.read();
          if (done) {
            // Stream ended naturally; reconnect after a brief pause if still connected
            if (this.connected) await this.delay(1000);
            break;
          }

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() ?? '';

          for (const line of lines) {
            if (line.startsWith('event:')) {
              currentEvent = line.slice(6).trim();
            } else if (line.startsWith('data:')) {
              currentData = line.slice(5).trim();
            } else if (line.startsWith('id:')) {
              currentId = line.slice(3).trim();
            } else if (line === '') {
              if (currentEvent && currentData) {
                if (currentId) this.lastEventId = currentId;
                try {
                  const data: unknown = JSON.parse(currentData);
                  this.dispatch(currentEvent, data, handlers);
                } catch {
                  /* skip malformed */
                }
              }
              currentEvent = '';
              currentData = '';
              currentId = '';
            }
          }
        }
      } catch {
        if (!this.connected) return;
        await this.delay(3000);
      }
    }
  }

  private dispatch(event: string, data: unknown, handlers: SSEEventHandler): void {
    switch (event) {
      case 'message.created':
        handlers.onMessageCreated?.(
          data as Parameters<NonNullable<SSEEventHandler['onMessageCreated']>>[0]
        );
        break;
      case 'message.updated':
        handlers.onMessageUpdated?.(
          data as Parameters<NonNullable<SSEEventHandler['onMessageUpdated']>>[0]
        );
        break;
      case 'message.deleted':
        handlers.onMessageDeleted?.(
          data as Parameters<NonNullable<SSEEventHandler['onMessageDeleted']>>[0]
        );
        break;
      case 'typing':
        handlers.onTyping?.(data as Parameters<NonNullable<SSEEventHandler['onTyping']>>[0]);
        break;
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms));
  }
}
