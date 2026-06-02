import { describe, expect, it } from 'bun:test';
import { createGlobalFeedManager } from './global-feed-manager';
import type { KiloGlobalFeedConnection } from './global-feed';

function createDeferredDone() {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>(resolvePromise => {
    resolve = resolvePromise;
  });

  return {
    promise,
    resolve: () => resolve?.(),
  };
}

function createTestManager() {
  const calls: string[] = [];
  let canOpen = true;
  let nextFeedId = 0;

  const manager = createGlobalFeedManager({
    canOpen: () => canOpen,
    open: () => {
      const feedId = ++nextFeedId;
      calls.push(`open:${feedId}`);
      return {
        close: () => calls.push(`close:${feedId}`),
        done: Promise.resolve(),
      } satisfies KiloGlobalFeedConnection;
    },
    onConnectionError: error => {
      throw error;
    },
    onOpenError: error => {
      throw error;
    },
  });

  return {
    calls,
    manager,
    setCanOpen: (value: boolean) => {
      canOpen = value;
    },
  };
}

describe('global feed readiness orchestration', () => {
  it('closes the existing feed immediately and keeps it closed while bootstrap readiness is pending', () => {
    const { calls, manager } = createTestManager();
    manager.onRuntimeReady();

    manager.onSessionBound('close-until-runtime-ready');

    expect(calls).toEqual(['open:1', 'close:1']);
  });

  it('opens exactly one replacement after runtime readiness succeeds', () => {
    const { calls, manager } = createTestManager();
    manager.onRuntimeReady();
    manager.onSessionBound('close-until-runtime-ready');

    manager.onRuntimeReady();

    expect(calls).toEqual(['open:1', 'close:1', 'open:2']);
  });

  it('leaves the feed closed when runtime readiness fails', () => {
    const { calls, manager } = createTestManager();
    manager.onRuntimeReady();
    manager.onSessionBound('close-until-runtime-ready');

    expect(calls).toEqual(['open:1', 'close:1']);
  });

  it('immediately replaces the feed for legacy direct bindings', () => {
    const { calls, manager } = createTestManager();
    manager.onRuntimeReady();

    manager.onSessionBound('restart');

    expect(calls).toEqual(['open:1', 'close:1', 'open:2']);
  });

  it('keeps a replacement feed tracked when the closed feed settles later', async () => {
    const calls: string[] = [];
    const doneByFeedId = new Map<number, ReturnType<typeof createDeferredDone>>();
    let nextFeedId = 0;
    const manager = createGlobalFeedManager({
      canOpen: () => true,
      open: () => {
        const feedId = ++nextFeedId;
        const done = createDeferredDone();
        doneByFeedId.set(feedId, done);
        calls.push(`open:${feedId}`);
        return {
          close: () => calls.push(`close:${feedId}`),
          done: done.promise,
        } satisfies KiloGlobalFeedConnection;
      },
      onConnectionError: error => {
        throw error;
      },
      onOpenError: error => {
        throw error;
      },
    });

    manager.onRuntimeReady();
    manager.onRuntimeReady();
    doneByFeedId.get(1)?.resolve();
    await Promise.resolve();
    await Promise.resolve();
    manager.onRuntimeReady();

    expect(calls).toEqual(['open:1', 'close:1', 'open:2', 'close:2', 'open:3']);
  });

  it('does not open a replacement until a Kilo client and session binding are available', () => {
    const { calls, manager, setCanOpen } = createTestManager();
    setCanOpen(false);

    manager.onRuntimeReady();

    expect(calls).toEqual([]);
  });
});
