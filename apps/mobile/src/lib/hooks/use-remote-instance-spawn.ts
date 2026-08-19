import { useMemo, useState } from 'react';
import { type KiloSessionId } from '@kilocode/cloud-agent-sdk';

import { useUserWebConnection } from '@/components/agents/user-web-connection-provider';
import { useOrganization } from '@/lib/organization-context';

// kilocode_change - K1/C2: the pure classifier/spawner logic lives in
// `remote-instance-spawn-classifier.ts`, a separate module with no React
// Native / Expo dependency, so it stays testable under a plain Node vitest
// environment (per the accepted plan: pure functions "testable without a
// React renderer"). This file's own `useUserWebConnection` import pulls in
// RN/Expo config transitively, which is why the split exists — see that
// file's header comment for the full explanation.
import {
  buildCreateRemoteSessionInput,
  type CreateRemoteSessionInput,
  type CreateSessionOutcome,
  createSessionSpawner,
  type CreateSessionSpawnOptions,
  mergeSpawnOrganizationId,
  resolveSpawnOrganizationId,
} from './remote-instance-spawn-classifier';

export type { CreateRemoteSessionInput, CreateSessionOutcome, CreateSessionSpawnOptions };
export { buildCreateRemoteSessionInput };

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
 *
 * The caller may pass a stable per-intent `operationKey` in the third
 * `spawn()` argument; the spawner forwards it to the SDK as `mutationId`
 * so a retry of the same intent dedupes against the relay instead of
 * spawning a second session.
 *
 * `organizationId` tri-state:
 *   - omitted (`undefined`) — inherit live `useOrganization()` (share-gate
 *     and other zero-arg callers that intentionally follow global context)
 *   - `null` — explicitly personal; never attribute to context org (wins
 *     over a later context switch after the route froze personal)
 *   - `string` — that org id
 *
 * Explicit `opts.orgId` on `spawn()` still wins when the caller sets it.
 */
export function useRemoteInstanceSpawn(organizationId?: string | null) {
  const connection = useUserWebConnection();
  const { organizationId: contextOrganizationId } = useOrganization();
  const resolvedOrganizationId = resolveSpawnOrganizationId(organizationId, contextOrganizationId);
  const [status, setStatus] = useState<RemoteInstanceSpawnStatus>({ status: 'idle' });

  // Re-create the spawner only when the connection reference changes
  // (provider mounts once, so this is effectively a singleton).
  const spawner = useMemo(() => createSessionSpawner(connection), [connection]);

  const spawn = async (
    connectionId: string,
    opts?: CreateRemoteSessionInput,
    options?: CreateSessionSpawnOptions
  ): Promise<CreateSessionOutcome> => {
    setStatus({ status: 'inFlight' });
    const merged = mergeSpawnOrganizationId(opts, resolvedOrganizationId);
    const outcome = await spawner.spawn(connectionId, merged, options);
    setStatus({ ...outcome, creationKey: spawner.creationKey });
    return outcome;
  };

  return { status, spawn };
}
