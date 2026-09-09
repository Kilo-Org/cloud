import { type Dispatch, type SetStateAction, useEffect } from 'react';
import { type TFunction } from 'i18next';

import {
  appendSpectatorRows,
  createSpectatorRowBatcher,
  type SpectatorRow,
  toSpectatorRow,
} from '@/components/code-reviewer/review-spectator-rows';
import {
  type Connection,
  createReviewSpectatorStream,
} from '@/components/code-reviewer/review-spectator-stream';

export function useReviewSpectatorLiveStream(input: {
  liveCloudId: string | null;
  organizationId?: string;
  retryNonce: number;
  t: TFunction;
  setLiveRows: Dispatch<SetStateAction<SpectatorRow[]>>;
  setLiveError: Dispatch<SetStateAction<boolean>>;
}): void {
  const { liveCloudId, organizationId, retryNonce, t, setLiveRows, setLiveError } = input;

  useEffect(() => {
    // Each effect run owns its dispose flag: a shared flag is reset at entry by
    // the next run, so a superseded start would see `false` after its own
    // cleanup ran and leave a second live socket. A run-local flag keeps the
    // stale start from calling `connect()` and makes it destroy its connection.
    let disposed = false;
    let connection: Connection | null = null;
    const clearLiveError = () => {
      if (!disposed) {
        setLiveError(false);
      }
    };
    const batcher = createSpectatorRowBatcher(batch => {
      if (!disposed) {
        setLiveRows(prev => appendSpectatorRows(prev, batch));
      }
    });

    void (async () => {
      if (liveCloudId === null) {
        return;
      }
      setLiveError(false);
      try {
        const created = await createReviewSpectatorStream({
          cloudAgentSessionId: liveCloudId,
          organizationId,
          onEvent: event => {
            if (disposed) {
              return;
            }
            const row = toSpectatorRow(event, t);
            if (row === null) {
              return;
            }
            // Synthetic events (connected, snapshots, queued messages) all carry
            // eventId 0. A shared key would collapse them into one row.
            const keyedRow =
              row.key === undefined && event.eventId > 0
                ? { ...row, key: `event-${event.eventId}` }
                : row;
            batcher.push(keyedRow);
          },
          onConnected: clearLiveError,
          onReconnected: clearLiveError,
          onDisconnected: () => {
            if (!disposed) {
              setLiveError(true);
            }
          },
          onError: () => {
            if (!disposed) {
              setLiveError(true);
            }
          },
        });
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- the cleanup closure sets `disposed` after this await resolves
        if (disposed) {
          created.destroy();
          return;
        }
        connection = created;
        created.connect();
      } catch {
        // oxlint-disable-next-line typescript-eslint/no-unnecessary-condition -- the cleanup closure sets `disposed` before this catch can run
        if (!disposed) {
          setLiveError(true);
        }
      }
    })();

    return () => {
      disposed = true;
      batcher.dispose();
      connection?.destroy();
    };
  }, [liveCloudId, organizationId, retryNonce, t, setLiveRows, setLiveError]);
}
