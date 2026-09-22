import { createKiloClient as createKiloEventClient } from '@kilocode/sdk/v2/client';
import {
  emitControlDiagnostic,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import { logToFile } from '../utils.js';
import { unfilteredKiloEvents } from './feed.js';
import {
  feedDirectoryName,
  KiloEventFeedError,
  observeKiloFeedResponse,
  startSandboxControlEventFeed,
  type KiloFeedConnection,
} from './sandbox-control-runtime.js';

export type KiloFeedEvent = {
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
  nativeRuntimeId: string;
};

export type WorktreeFeedSource = Readonly<{
  scopeId: string;
  runtimeId: string;
  directory: string;
  kiloClient: Pick<WrapperKiloClient, 'serverUrl'>;
  signal: AbortSignal;
}>;

export type WorktreeFeed = {
  open(): Promise<void>;
  isFresh(): boolean;
  isRecovering(): boolean;
  prepareForNewWork(): boolean;
  close(): void;
};

export function createWorktreeFeed(options: {
  source: WorktreeFeedSource;
  isCurrent: (runtimeId: string, client: WorktreeFeedSource['kiloClient']) => boolean;
  onEvent?: (event: KiloFeedEvent) => unknown;
  onFailure: (reason: KiloEventFeedError['reason']) => void;
  onStateChange?: () => void;
  onDiagnostic?: ControlDiagnosticReporter;
  log?: (message: string) => void;
  now?: () => number;
  /** Test seam; production defaults to an abortable real-timer sleep. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}): WorktreeFeed {
  const { scopeId, runtimeId, directory, kiloClient, signal: processSignal } = options.source;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, processSignal]);
  const log = options.log ?? logToFile;
  const sleep =
    options.sleep ??
    ((ms: number, abortSignal: AbortSignal) =>
      new Promise<void>(resolve => {
        if (abortSignal.aborted) {
          resolve();
          return;
        }
        const done = (): void => {
          clearTimeout(timer);
          abortSignal.removeEventListener('abort', done);
          resolve();
        };
        const timer = setTimeout(done, ms);
        abortSignal.addEventListener('abort', done, { once: true });
      }));
  let feed: Awaited<ReturnType<typeof startSandboxControlEventFeed>> | undefined;
  let failureReported = false;

  function logFeed(fields: string): void {
    log(
      `control feed scopeId=${scopeId} runtimeId=${runtimeId} directory=${feedDirectoryName(directory)} ${fields}`
    );
  }

  function openSdk(
    feedSignal: AbortSignal,
    onActivity: () => void,
    onFrame: (frame: string) => void,
    connection: KiloFeedConnection
  ): Promise<{ stream?: AsyncIterable<unknown> }> {
    const abortableSleep = async (ms: number): Promise<void> => {
      logFeed(`phase=retry_delay delayMs=${ms}`);
      await sleep(ms, feedSignal);
      connection.hooks.onSleepWake();
    };
    const feedFetch: typeof fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
      const composite = connection.hooks.beginAttempt();
      composite.throwIfAborted();
      connection.hooks.onGetStart();
      const init: RequestInit & { duplex: 'half'; timeout: false } = {
        ...args[1],
        duplex: 'half',
        timeout: false,
        signal: composite,
      };
      const response = await fetch(args[0], init);
      composite.throwIfAborted();
      return observeKiloFeedResponse(response, composite, onActivity, onFrame);
    }, fetch);
    const eventClient = createKiloEventClient({
      baseUrl: kiloClient.serverUrl,
      directory,
      fetch: feedFetch,
    });
    const sseOptions: Parameters<typeof eventClient.global.event>[0] & {
      sseSleepFn: (ms: number) => Promise<void>;
    } = {
      signal: feedSignal,
      sseMaxRetryAttempts: connection.sseMaxRetryAttempts,
      sseSleepFn: abortableSleep,
      onSseError: (error: unknown) => connection.hooks.onSseError(error),
    };
    return eventClient.global.event(sseOptions);
  }

  function close(): void {
    lifetime.abort();
    feed?.close();
  }

  // Producer-lifetime guard: the caller's registry can replace or retire this
  // runtime while the feed is still running. Do not serve stale events or
  // report failures for an incarnation that no longer owns the directory.
  function producerCurrent(): boolean {
    return !signal.aborted && options.isCurrent(runtimeId, kiloClient);
  }

  processSignal.addEventListener('abort', close, { once: true });
  if (processSignal.aborted) close();

  return {
    async open() {
      if (!producerCurrent()) throw new Error('Native feed source was superseded');
      feed?.close();
      failureReported = false;
      feed = await startSandboxControlEventFeed({
        signal,
        open: openSdk,
        consume: async stream => {
          for await (const event of unfilteredKiloEvents(stream)) {
            if (!producerCurrent()) {
              close();
              return;
            }
            void options.onEvent?.({ ...event, nativeRuntimeId: runtimeId });
          }
        },
        onUnexpectedClose: error => {
          if (failureReported || !producerCurrent()) return;
          failureReported = true;
          options.onStateChange?.();
          options.onFailure(error instanceof KiloEventFeedError ? error.reason : 'feed_failed');
        },
        onDiagnostic: options.onDiagnostic
          ? (event, fields) =>
              emitControlDiagnostic(options.onDiagnostic, event, { ...fields, scopeId })
          : undefined,
        log,
        identity: { scopeId, runtimeId, directory },
        ...(options.now ? { now: options.now } : {}),
      });
    },
    isFresh() {
      return producerCurrent() && feed?.isFresh() === true;
    },
    isRecovering() {
      return producerCurrent() && feed?.isRecovering() === true;
    },
    prepareForNewWork() {
      if (!producerCurrent() || !feed) return false;
      return feed.isFresh() && !feed.isRecovering();
    },
    close,
  };
}
