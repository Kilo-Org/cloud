import { createKiloClient as createKiloEventClient } from '@kilocode/sdk/v2/client';
import { unfilteredKiloEvents } from '../control/feed.js';
import type { KiloFeedEvent } from '../control/worktree-feed.js';
import { logToFile } from '../utils.js';

export type { KiloFeedEvent };

export type KiloEventFeedSource = Readonly<{
  directory: string;
  serverUrl: string;
  nativeRuntimeId: string;
}>;

export type KiloEventFeed = {
  open(): Promise<void>;
  close(): void;
};

export type KiloEventFeedOptions = {
  source: KiloEventFeedSource;
  /** The runtime's abort signal; aborting it ends the connection. */
  signal: AbortSignal;
  onEvent: (event: KiloFeedEvent) => void;
  /** The connection ended or failed after `open()` resolved. */
  onFailure: () => void;
  log?: (message: string) => void;
};

/**
 * The control plane's Kilo `/global/event` reader. One instance owns one SSE
 * connection and holds no watchdog, timeout or reconnect budget: `kilo-runtime.ts`
 * owns the hang rule, aborts a hung attempt through `signal`, and reconnects by
 * closing this feed and opening a new one against the same Kilo.
 */
export function createKiloEventFeed(options: KiloEventFeedOptions): KiloEventFeed {
  const { directory, serverUrl, nativeRuntimeId } = options.source;
  const log = options.log ?? logToFile;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, options.signal]);
  let closed = false;
  let opened = false;

  async function consume(
    events: AsyncGenerator<{
      type: string;
      properties: Record<string, unknown>;
      directory?: string;
    }>
  ): Promise<void> {
    try {
      for await (const event of events) {
        if (closed || signal.aborted) return;
        options.onEvent({ ...event, nativeRuntimeId });
      }
    } catch {
      // Reported as an ended stream below.
    }
    if (!closed && !signal.aborted) {
      log(`control feed directory=${directory} phase=ended`);
      options.onFailure();
    }
  }

  return {
    async open(): Promise<void> {
      if (opened) throw new Error('Kilo event feed is already open');
      log(`control feed directory=${directory} phase=opening`);
      const client = createKiloEventClient({ baseUrl: serverUrl, directory });
      const result = await client.global.event({ signal, sseMaxRetryAttempts: 1 });
      if (!result.stream) throw new Error('Kilo global event feed is unavailable');
      const events = unfilteredKiloEvents(result.stream);
      const first = await events.next();
      if (signal.aborted || first.done) {
        throw new Error('Kilo global event feed did not connect');
      }
      opened = true;
      log(`control feed directory=${directory} phase=connected`);
      options.onEvent({ ...first.value, nativeRuntimeId });
      void consume(events).catch(() => undefined);
    },
    close(): void {
      if (closed) return;
      closed = true;
      lifetime.abort();
    },
  };
}
