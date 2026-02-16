/**
 * SSE-based preview events hook.
 *
 * Replaces polling with a persistent Server-Sent Events connection to the
 * Cloudflare worker for real-time preview status, build logs, and sleep events.
 *
 * Reconnection uses exponential backoff with jitter and fetches a fresh JWT
 * ticket on each reconnect (tickets expire after 5 minutes).
 */

import type { AppTRPCClient, PreviewStatus, ProjectStore } from './types';

const PREVIEW_STATUSES: readonly PreviewStatus[] = [
  'idle',
  'building',
  'running',
  'error',
  'sleeping',
];

function isPreviewStatus(s: string): s is PreviewStatus {
  return (PREVIEW_STATUSES as readonly string[]).includes(s);
}

/**
 * SSE event types mirrored from cloudflare-app-builder/src/types.ts.
 * Duplicated here to avoid pulling Cloudflare-specific ambient types
 * (CloudflareEnv, DurableObjectNamespace, etc.) into the Next.js compilation.
 */
type AppBuilderEvent =
  | { type: 'status'; state: string; previewUrl?: string }
  | { type: 'log'; source: 'build' | 'dev-server'; message: string; timestamp: string }
  | { type: 'error'; message: string }
  | { type: 'container-stopped' };

export type PreviewEventsConfig = {
  projectId: string;
  organizationId: string | null;
  trpcClient: AppTRPCClient;
  store: ProjectStore;
  isDestroyed: () => boolean;
};

type PreviewEventsHandle = {
  stop: () => void;
};

const MAX_RECONNECT_ATTEMPTS = 8;
const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

function reconnectDelay(attempt: number): number {
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * Math.pow(2, attempt));
  // Jitter: 0.5x–1.5x
  return exponential * (0.5 + Math.random());
}

async function fetchTicket(
  projectId: string,
  organizationId: string | null,
  trpcClient: AppTRPCClient
): Promise<{ ticket: string; workerUrl: string }> {
  const result = organizationId
    ? await trpcClient.organizations.appBuilder.getEventsTicket.query({
        projectId,
        organizationId,
      })
    : await trpcClient.appBuilder.getEventsTicket.query({ projectId });

  return { ticket: result.ticket, workerUrl: result.workerUrl };
}

/**
 * Parse an SSE text chunk into events.
 * Handles the `event:` and `data:` fields of the SSE protocol.
 * Comment lines (starting with `:`) are silently ignored (keepalives).
 */
function parseSSEChunk(chunk: string): AppBuilderEvent[] {
  const events: AppBuilderEvent[] = [];
  const lines = chunk.split('\n');

  let currentData: string | null = null;

  for (const line of lines) {
    if (line.startsWith(':')) {
      // SSE comment (keepalive), ignore
      continue;
    }

    if (line.startsWith('data: ')) {
      currentData = line.slice(6);
    } else if (line === '' && currentData !== null) {
      // Empty line = end of event
      try {
        const parsed = JSON.parse(currentData);
        events.push(parsed);
      } catch {
        // Malformed JSON, skip
      }
      currentData = null;
    }
  }

  return events;
}

function handleEvent(event: AppBuilderEvent, store: ProjectStore): void {
  switch (event.type) {
    case 'status': {
      // Map worker's PreviewState to our PreviewStatus
      // 'uninitialized' has no UI equivalent — treat it as 'idle'
      const previewStatus: PreviewStatus =
        event.state === 'uninitialized'
          ? 'idle'
          : isPreviewStatus(event.state)
            ? event.state
            : 'idle';
      const partial: Partial<ReturnType<typeof store.getState>> = { previewStatus };
      if (event.previewUrl) {
        partial.previewUrl = event.previewUrl;
      }
      store.setState(partial);
      break;
    }
    case 'log':
      // Log events are available for future UI use (build terminal, etc.)
      // For now, they are not surfaced in the UI.
      break;
    case 'error':
      // Error details are available for future UI use
      break;
    case 'container-stopped':
      store.setState({ previewStatus: 'sleeping' });
      break;
  }
}

async function connectAndStream(
  config: PreviewEventsConfig,
  abortController: AbortController
): Promise<'container-stopped' | 'destroyed' | 'exhausted'> {
  const { projectId, organizationId, trpcClient, store, isDestroyed } = config;
  const { signal } = abortController;

  let attempt = 0;

  while (attempt <= MAX_RECONNECT_ATTEMPTS && !isDestroyed()) {
    let containerStopped = false;

    try {
      const { ticket, workerUrl } = await fetchTicket(projectId, organizationId, trpcClient);
      if (isDestroyed()) return 'destroyed';

      const url = `${workerUrl}/apps/${encodeURIComponent(projectId)}/events?ticket=${encodeURIComponent(ticket)}`;
      const response = await fetch(url, {
        headers: { Accept: 'text/event-stream' },
        signal,
      });

      if (!response.ok) {
        throw new Error(`SSE connection failed: ${response.status}`);
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      // Reset attempt counter on successful connection
      attempt = 0;

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Abort the reader when the controller fires
      signal.addEventListener('abort', () => reader.cancel().catch(() => {}), { once: true });

      while (!isDestroyed()) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Process complete events (delimited by double newlines)
        const parts = buffer.split('\n\n');
        // Keep the last incomplete part in the buffer
        buffer = parts.pop() ?? '';

        for (const part of parts) {
          if (!part.trim()) continue;
          const events = parseSSEChunk(part + '\n\n');
          for (const event of events) {
            handleEvent(event, store);
            if (event.type === 'container-stopped') {
              containerStopped = true;
            }
          }
        }
      }

      // Stream ended cleanly (server closed). If not destroyed, reconnect.
      if (isDestroyed()) return 'destroyed';

      // Don't reconnect after container sleep — wait for visibility change
      if (containerStopped) return 'container-stopped';
    } catch {
      if (isDestroyed()) return 'destroyed';
    }

    attempt++;
    if (attempt > MAX_RECONNECT_ATTEMPTS) {
      // Give up — set error state
      store.setState({ previewStatus: 'error' });
      return 'exhausted';
    }

    const delay = reconnectDelay(attempt);
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  return 'destroyed';
}

/**
 * Start listening for preview events via SSE.
 * Returns a handle to stop the connection.
 *
 * After a `container-stopped` event, SSE does not auto-reconnect. Instead,
 * a `visibilitychange` listener reconnects when the user returns to the tab.
 * This ensures `eventWriters.size === 0` on the DO is a reliable "no active
 * user" signal for deferring push-triggered builds.
 */
export function startPreviewEvents(config: PreviewEventsConfig): PreviewEventsHandle {
  let stopped = false;
  const abortController = new AbortController();

  const isStopped = () => stopped || config.isDestroyed();

  function startConnection(): void {
    const controller = new AbortController();

    // Forward top-level abort to per-connection controller
    abortController.signal.addEventListener('abort', () => controller.abort(), { once: true });

    const innerConfig: PreviewEventsConfig = {
      ...config,
      isDestroyed: isStopped,
    };

    void connectAndStream(innerConfig, controller).then(reason => {
      if (reason !== 'container-stopped') return;
      if (isStopped()) return;

      // If the tab is already visible, reconnect immediately.
      // Otherwise wait for visibility change before reconnecting.
      // This triggers subscribeEvents() on the DO which checks pendingBuild.
      if (document.visibilityState === 'visible') {
        startConnection();
        return;
      }

      const onVisibilityChange = () => {
        if (document.visibilityState !== 'visible') return;
        document.removeEventListener('visibilitychange', onVisibilityChange);
        if (isStopped()) return;
        startConnection();
      };
      document.addEventListener('visibilitychange', onVisibilityChange);

      // Clean up listener on stop
      abortController.signal.addEventListener(
        'abort',
        () => document.removeEventListener('visibilitychange', onVisibilityChange),
        { once: true }
      );
    });
  }

  startConnection();

  return {
    stop: () => {
      stopped = true;
      abortController.abort();
    },
  };
}
