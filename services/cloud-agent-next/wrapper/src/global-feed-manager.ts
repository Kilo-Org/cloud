import type { KiloGlobalFeedConnection } from './global-feed.js';

export type SessionBoundFeedPolicy = 'restart' | 'close-until-runtime-ready';

export type GlobalFeedManager = {
  close(): void;
  onRuntimeReady(): void;
  onSessionBound(feedPolicy: SessionBoundFeedPolicy): void;
};

type GlobalFeedManagerDependencies = {
  canOpen(): boolean;
  open(): KiloGlobalFeedConnection;
  onConnectionError(error: unknown): void;
  onOpenError(error: unknown): void;
};

export function createGlobalFeedManager(deps: GlobalFeedManagerDependencies): GlobalFeedManager {
  let connection: KiloGlobalFeedConnection | undefined;

  function close(): void {
    connection?.close();
    connection = undefined;
  }

  function restart(): void {
    close();
    if (!deps.canOpen()) return;

    try {
      const nextConnection = deps.open();
      connection = nextConnection;
      void nextConnection.done
        .catch(error => {
          deps.onConnectionError(error);
        })
        .finally(() => {
          if (connection === nextConnection) {
            connection = undefined;
          }
        });
    } catch (error) {
      deps.onOpenError(error);
    }
  }

  return {
    close,
    onRuntimeReady: restart,
    onSessionBound: feedPolicy => {
      if (feedPolicy === 'close-until-runtime-ready') {
        close();
        return;
      }
      restart();
    },
  };
}
