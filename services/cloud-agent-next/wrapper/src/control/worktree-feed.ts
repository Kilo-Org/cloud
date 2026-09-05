import { setTimeout as delay } from 'node:timers/promises';
import { createKiloClient as createKiloEventClient } from '@kilocode/sdk/v2/client';
import {
  emitControlDiagnostic,
  type ControlDiagnosticReporter,
} from '../../../src/shared/control-diagnostics.js';
import { SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS } from '../../../src/shared/sandbox-control-protocol.js';
import type { WrapperKiloClient } from '../kilo-api.js';
import { unfilteredKiloEvents } from './feed.js';
import {
  KILO_CONTROL_REQUEST_TIMEOUT_MS,
  KILO_FEED_FRESHNESS_TIMEOUT_MS,
  KiloEventFeedError,
  observeKiloFeedResponse,
  startSandboxControlEventFeed,
} from './sandbox-control-runtime.js';

export type KiloFeedEvent = {
  type: string;
  properties: Record<string, unknown>;
  directory?: string;
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
  prepareForNewWork(): boolean;
  close(): void;
};

type FeedAttempt = {
  controller: AbortController;
  failure: PromiseWithResolvers<unknown>;
  failed: boolean;
  feed?: Awaited<ReturnType<typeof startSandboxControlEventFeed>>;
};

type Recovery = {
  controller: AbortController;
  deadlineAt: number;
  reason: KiloEventFeedError['reason'];
};

export function createWorktreeFeed(options: {
  source: WorktreeFeedSource;
  isCurrent: (runtimeId: string, client: WorktreeFeedSource['kiloClient']) => boolean;
  onEvent?: (event: KiloFeedEvent) => void;
  onFailure: (reason: KiloEventFeedError['reason']) => void;
  onStateChange?: () => void;
  onDiagnostic?: ControlDiagnosticReporter;
}): WorktreeFeed {
  const { scopeId, runtimeId, directory, kiloClient, signal: processSignal } = options.source;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([lifetime.signal, processSignal]);
  let active: FeedAttempt | undefined;
  let recovery: Recovery | undefined;
  let state: 'opening' | 'ready' | 'recovering' | 'unavailable' = 'opening';

  function isCurrent(): boolean {
    return !signal.aborted && options.isCurrent(runtimeId, kiloClient);
  }

  function isCurrentAttempt(attempt: FeedAttempt): boolean {
    return isCurrent() && active === attempt && !attempt.controller.signal.aborted;
  }

  function closeActive(): void {
    const attempt = active;
    active = undefined;
    attempt?.controller.abort();
    const close = attempt?.feed?.close;
    if (typeof close === 'function') close();
  }

  function failAttempt(attempt: FeedAttempt, error: unknown): void {
    if (attempt.failed) return;
    attempt.failed = true;
    attempt.failure.resolve(error);
    attempt.controller.abort();
    const close = attempt.feed?.close;
    if (typeof close === 'function') close();
  }

  async function connect(deadlineAt?: number): Promise<void> {
    if (!isCurrent()) throw new Error('Native feed source was superseded');
    const attempt: FeedAttempt = {
      controller: new AbortController(),
      failure: Promise.withResolvers<unknown>(),
      failed: false,
    };
    active = attempt;
    const attemptSignal = AbortSignal.any([signal, attempt.controller.signal]);
    const feed = await startSandboxControlEventFeed({
      signal: attemptSignal,
      deadlineAt,
      open: (feedSignal, onActivity, onFrame) => {
        const feedFetch: typeof fetch = Object.assign(async (...args: Parameters<typeof fetch>) => {
          feedSignal.throwIfAborted();
          const init: RequestInit & { duplex: 'half'; timeout: false } = {
            ...args[1],
            duplex: 'half',
            timeout: false,
          };
          const response = await fetch(args[0], init);
          feedSignal.throwIfAborted();
          return observeKiloFeedResponse(response, feedSignal, onActivity, onFrame);
        }, fetch);
        const eventClient = createKiloEventClient({
          baseUrl: kiloClient.serverUrl,
          directory,
          fetch: feedFetch,
        });
        return eventClient.global.event({
          signal: feedSignal,
          sseMaxRetryAttempts: 1,
          onSseError: () => {
            if (!feedSignal.aborted)
              throw new KiloEventFeedError('feed_failed', 'Kilo global event feed failed');
          },
        });
      },
      consume: async stream => {
        for await (const event of unfilteredKiloEvents(stream)) {
          if (!isCurrentAttempt(attempt)) return;
          options.onEvent?.(event);
        }
      },
      onUnexpectedClose: error => {
        if (!isCurrentAttempt(attempt)) return;
        failAttempt(attempt, error);
        if (state === 'ready')
          recover(error instanceof KiloEventFeedError ? error.reason : 'feed_failed');
      },
      onDiagnostic: options.onDiagnostic
        ? (event, fields) =>
            emitControlDiagnostic(options.onDiagnostic, event, { ...fields, scopeId })
        : undefined,
    });
    if (!isCurrentAttempt(attempt) || attempt.failed) {
      feed.close();
      throw new Error('Native feed attempt was superseded');
    }
    attempt.feed = feed;
    if (deadlineAt !== undefined) {
      const usable = await Promise.race([feed.usable, attempt.failure.promise.then(() => false)]);
      if (!usable || !isCurrentAttempt(attempt) || attempt.failed) {
        feed.close();
        throw new Error('Native feed attempt closed before becoming usable');
      }
    }
  }

  function unavailable(current: Recovery): void {
    if (!isCurrent() || recovery !== current) return;
    recovery = undefined;
    state = 'unavailable';
    options.onStateChange?.();
    options.onFailure(current.reason);
  }

  async function retry(current: Recovery): Promise<void> {
    for (let attempt = 1; attempt <= SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS; attempt++) {
      if (!isCurrent() || recovery !== current || current.controller.signal.aborted) return;
      const deadlineAt = Math.min(current.deadlineAt, Date.now() + KILO_CONTROL_REQUEST_TIMEOUT_MS);
      if (Date.now() >= deadlineAt) break;
      try {
        await connect(deadlineAt);
        if (!isCurrent() || recovery !== current || current.controller.signal.aborted) return;
        recovery = undefined;
        state = 'ready';
        options.onStateChange?.();
        return;
      } catch {
        if (!isCurrent() || recovery !== current || current.controller.signal.aborted) return;
        closeActive();
        if (attempt === SANDBOX_CONTROL_RECOVERY_MAX_ATTEMPTS || Date.now() >= current.deadlineAt)
          break;
        await delay(
          Math.min(1_000 * 2 ** (attempt - 1), Math.max(0, current.deadlineAt - Date.now())),
          undefined,
          { signal: current.controller.signal }
        ).catch(() => undefined);
      }
    }
    unavailable(current);
  }

  function recover(reason: KiloEventFeedError['reason']): void {
    if (!isCurrent() || state === 'unavailable') return;
    if (recovery) return;
    const current: Recovery = {
      controller: new AbortController(),
      deadlineAt: Date.now() + KILO_FEED_FRESHNESS_TIMEOUT_MS,
      reason,
    };
    recovery = current;
    state = 'recovering';
    closeActive();
    options.onStateChange?.();
    void retry(current);
  }

  function close(): void {
    lifetime.abort();
    recovery?.controller.abort();
    recovery = undefined;
    closeActive();
  }

  processSignal.addEventListener('abort', close, { once: true });
  if (processSignal.aborted) close();

  return {
    async open() {
      if (!isCurrent()) throw new Error('Native feed source was superseded');
      if (state === 'unavailable') throw new Error('Native feed recovery is unavailable');
      closeActive();
      state = 'opening';
      await connect();
      if (!isCurrent()) throw new Error('Native feed source was superseded');
      state = 'ready';
      options.onStateChange?.();
    },
    isFresh() {
      return state === 'ready' && active?.feed?.isFresh() === true;
    },
    prepareForNewWork() {
      if (!isCurrent() || state === 'unavailable') return false;
      if (state === 'ready' && active?.feed?.isFresh() === true) return true;
      if (state === 'ready') recover('feed_stale');
      return false;
    },
    close,
  };
}
