import { E2E_LATENCY_WS_MS } from '@/lib/config';

type MessageListener = ((event: MessageEvent) => void) | null;

/**
 * E2E-only artificial WebSocket latency (companion to the tRPC latency in
 * lib/trpc.ts). Real networks delay live-transport messages as much as HTTP;
 * the local stack delivers them in milliseconds, which hides latency-dependent
 * UI states (e.g. the session-open empty flash, where the empty transcript
 * renders between attach and the first live message). When E2E_LATENCY_WS_MS
 * is set at Metro bundle time, every WebSocket `onmessage` dispatch happens
 * that many milliseconds late — the same condition a slow production network
 * creates. Disabled (0) unless explicitly set; never set it outside E2E.
 */
export function installE2EWebSocketLatency(): void {
  if (E2E_LATENCY_WS_MS <= 0) {
    return;
  }
  const NativeWebSocket = globalThis.WebSocket;
  const delayMs = E2E_LATENCY_WS_MS;

  class E2EDelayedWebSocket extends NativeWebSocket {
    private e2eOnmessage: MessageListener = null;
    private e2eWrapped: MessageListener = null;

    override get onmessage(): MessageListener {
      return this.e2eOnmessage;
    }

    override set onmessage(listener: MessageListener) {
      if (this.e2eWrapped) {
        super.removeEventListener('message', this.e2eWrapped);
      }
      this.e2eOnmessage = listener;
      this.e2eWrapped = listener
        ? event => {
            setTimeout(() => {
              listener(event);
            }, delayMs);
          }
        : null;
      if (this.e2eWrapped) {
        super.addEventListener('message', this.e2eWrapped);
      }
    }
  }

  globalThis.WebSocket = E2EDelayedWebSocket as typeof WebSocket;
}
