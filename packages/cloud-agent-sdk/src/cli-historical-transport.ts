/**
 * CLI historical transport — loads a completed CLI session snapshot and replays
 * it as events through the TransportSink. Allows viewing historical CLI sessions
 * using the same ChatProcessor + ServiceState pipeline used for live sessions.
 */
import type {
  KiloSessionId,
  SessionSnapshot,
  SessionSnapshotPage,
  SessionSnapshotPageOutcome,
} from './types';
import type { TransportFactory, TransportSink } from './transport';

type CliHistoricalTransportConfig = {
  kiloSessionId: KiloSessionId;
  /**
   * Legacy full-snapshot fetch. Kept for callers that haven't migrated to
   * the paginated endpoint yet. `fetchSnapshotPage` takes precedence when
   * both are provided.
   */
  fetchSnapshot?: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  /**
   * Page-aware initial snapshot fetch. When provided, the historical
   * transport uses it for the initial bounded read (newest 50) so the
   * user can load older pages later via the manager's `loadOlderMessages`.
   * The transport fires `onInitialPageLoaded` so the manager can record
   * the cursor.
   */
  fetchSnapshotPage?: (
    kiloSessionId: KiloSessionId,
    options: { cursor?: string }
  ) => Promise<SessionSnapshotPageOutcome | null>;
  /** Called after a successful initial bounded page read. */
  onInitialPageLoaded?: (page: SessionSnapshotPage) => void;
  onError?: (message: string) => void;
};

function createCliHistoricalTransport(config: CliHistoricalTransportConfig): TransportFactory {
  return (sink: TransportSink) => {
    let generation = 0;

    function replayPage(page: SessionSnapshotPage): void {
      sink.onServiceEvent({ type: 'session.created', info: page.info });

      for (const msg of page.messages) {
        sink.onChatEvent({ type: 'message.updated', info: msg.info });

        for (const part of msg.parts) {
          sink.onChatEvent({ type: 'message.part.updated', part });
        }
      }

      sink.onServiceEvent({ type: 'stopped', reason: 'complete' });
    }

    function replaySnapshot(snapshot: SessionSnapshot): void {
      replayPage({
        info: snapshot.info,
        messages: snapshot.messages,
        nextCursor: null,
        omittedItemCount: 0,
      });
    }

    return {
      connect() {
        generation += 1;
        const expectedGeneration = generation;

        if (config.fetchSnapshotPage) {
          void config.fetchSnapshotPage(config.kiloSessionId, {}).then(
            page => {
              if (expectedGeneration !== generation) return;
              if (page === null) {
                const message = 'Session not found';
                config.onError?.(message);
                sink.onServiceEvent({ type: 'stopped', reason: 'error' });
                return;
              }
              if (page.kind === 'success') {
                config.onInitialPageLoaded?.(page);
                replayPage(page);
                return;
              }
              // Typed failure: surface via onError and mark the session as
              // stopped with `error` so the UI doesn't appear to load
              // forever.
              const message =
                page.kind === 'retryable_failure'
                  ? 'Session history temporarily unavailable'
                  : page.kind === 'too_large'
                    ? 'Session history too large to load'
                    : 'Session history is unavailable';
              config.onError?.(message);
              sink.onServiceEvent({ type: 'stopped', reason: 'error' });
            },
            (error: unknown) => {
              if (expectedGeneration !== generation) return;
              const message = error instanceof Error ? error.message : 'Failed to fetch snapshot';
              config.onError?.(message);
              sink.onServiceEvent({ type: 'stopped', reason: 'error' });
            }
          );
          return;
        }

        if (!config.fetchSnapshot) {
          const message = 'fetchSnapshot is not configured';
          config.onError?.(message);
          sink.onServiceEvent({ type: 'stopped', reason: 'error' });
          return;
        }

        void config.fetchSnapshot(config.kiloSessionId).then(
          snapshot => {
            if (expectedGeneration !== generation) return;
            replaySnapshot(snapshot);
          },
          (error: unknown) => {
            if (expectedGeneration !== generation) return;
            const message = error instanceof Error ? error.message : 'Failed to fetch snapshot';
            config.onError?.(message);
            sink.onServiceEvent({ type: 'stopped', reason: 'error' });
          }
        );
      },

      disconnect() {
        generation += 1;
      },

      destroy() {
        generation += 1;
      },
    };
  };
}

export { createCliHistoricalTransport };
export type { CliHistoricalTransportConfig };
