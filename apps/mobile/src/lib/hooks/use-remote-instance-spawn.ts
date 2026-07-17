import { useMemo, useState } from 'react';
import { type KiloSessionId } from 'cloud-agent-sdk';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';

// kilocode_change - K1/C2: the pure classifier/spawner logic lives in
// `remote-instance-spawn-classifier.ts`, a separate module with no React
// Native / Expo dependency, so it stays testable under a plain Node vitest
// environment (per the accepted plan: pure functions "testable without a
// React renderer"). This file's own `useUserWebConnection` import pulls in
// RN/Expo config transitively, which is why the split exists — see that
// file's header comment for the full explanation.
import {
  type CreateSessionOutcome,
  createSessionSpawner,
} from './remote-instance-spawn-classifier';

export type { CreateSessionOutcome };

export type RemoteInstanceSpawnStatus =
  | { status: 'idle' }
  | { status: 'inFlight' }
  | ({ status: 'ready'; sessionID: KiloSessionId } & {
      creationKey: string;
    })
  | ({ status: 'retryable' | 'nonRetryable'; reason: string } & {
      creationKey: string;
    });

/**
 * Thin React hook wrapper around `createSessionSpawner`. Holds the latest
 * status in component state so UI can re-render on each attempt. The
 * underlying SDK call is one-shot per `spawn()` call — no in-hook retry
 * loop, no toast, no debouncing; the caller drives those.
 */
export function useRemoteInstanceSpawn(): {
  status: RemoteInstanceSpawnStatus;
  spawn: (connectionId: string) => Promise<CreateSessionOutcome>;
} {
  const connection = useUserWebConnection();
  const [status, setStatus] = useState<RemoteInstanceSpawnStatus>({ status: 'idle' });

  // Re-create the spawner only when the connection reference changes
  // (provider mounts once, so this is effectively a singleton).
  const spawner = useMemo(() => createSessionSpawner(connection), [connection]);

  const spawn = async (connectionId: string): Promise<CreateSessionOutcome> => {
    setStatus({ status: 'inFlight' });
    const outcome = await spawner.spawn(connectionId);
    setStatus({ ...outcome, creationKey: spawner.creationKey });
    return outcome;
  };

  return { status, spawn };
}
