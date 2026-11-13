import { useMutation, useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useSyncExternalStore } from 'react';
import { toast } from 'sonner-native';

import {
  createForward,
  deleteForward,
  listForwardsForHost,
  type SshForward,
  type SshForwardInput,
  updateForward,
} from './forwards';
import { forwardsSnapshot, type ForwardStatus, subscribeForwards } from './forwards-runtime';
import { sshDatabase } from './store';
import { SSH_KEY, useSshInvalidation } from './use-ssh';

const EMPTY: ReadonlyMap<string, ForwardStatus> = new Map();

/** What each of the session's forwards is doing right now. */
export function useForwardStatuses(sessionId: string): ReadonlyMap<string, ForwardStatus> {
  const all = useSyncExternalStore(subscribeForwards, forwardsSnapshot, forwardsSnapshot);
  return all.get(sessionId) ?? EMPTY;
}

/** The forwards stored for one host. A null host reads nothing. */
export type SshForwardsQuery = UseQueryResult<SshForward[], Error>;

export function useSshForwards(hostId: string | null): SshForwardsQuery {
  return useQuery({
    queryKey: [...SSH_KEY, 'forwards', hostId],
    networkMode: 'always',
    enabled: hostId !== null,
    queryFn: async () => (hostId === null ? [] : listForwardsForHost(await sshDatabase(), hostId)),
  });
}

type SaveForwardInput = Readonly<{ id: string | null; forward: SshForwardInput }>;

export function useSshForwardMutations() {
  const invalidate = useSshInvalidation();
  const save = useMutation({
    mutationFn: async (input: SaveForwardInput): Promise<SshForward> => {
      const db = await sshDatabase();
      return input.id === null
        ? createForward(db, input.forward)
        : updateForward(db, input.id, input.forward);
    },
    onSuccess: () => void invalidate(),
    onError: error => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      deleteForward(await sshDatabase(), id);
    },
    onSuccess: () => void invalidate(),
    onError: error => toast.error(error.message),
  });
  return { save, remove };
}
