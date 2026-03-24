/**
 * CLI historical transport — loads a completed CLI session snapshot and replays
 * it as events through the TransportSink. Allows viewing historical CLI sessions
 * using the same ChatProcessor + ServiceState pipeline used for live sessions.
 */
import type { KiloSessionId, SessionSnapshot } from './types';
import type { TransportFactory, TransportSink } from './transport';

type CliHistoricalTransportConfig = {
  kiloSessionId: KiloSessionId;
  fetchSnapshot: (kiloSessionId: KiloSessionId) => Promise<SessionSnapshot>;
  onError?: (message: string) => void;
};

function createCliHistoricalTransport(config: CliHistoricalTransportConfig): TransportFactory {
  return (sink: TransportSink) => {
    let generation = 0;

    function replaySnapshot(snapshot: SessionSnapshot): void {
      sink.onServiceEvent({ type: 'session.created', info: snapshot.info });

      for (const msg of snapshot.messages) {
        sink.onChatEvent({ type: 'message.updated', info: msg.info });

        for (const part of msg.parts) {
          sink.onChatEvent({ type: 'message.part.updated', part });
        }
      }

      sink.onServiceEvent({ type: 'stopped', reason: 'complete' });
    }

    return {
      connect() {
        generation += 1;
        const expectedGeneration = generation;

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
