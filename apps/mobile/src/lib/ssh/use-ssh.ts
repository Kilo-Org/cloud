import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';

import { importSshConfig, type SshConfigPlan } from './config-import';
import { createHost, deleteHost, getHost, listHosts, type SshHostInput, updateHost } from './hosts';
import { listKeys } from './keys';
import { listKnownHosts, removeKnownHost } from './known-hosts';
import { sshDatabase } from './store';

/** Every ssh query lives under this key, so one invalidation refreshes a screen. */
export const SSH_KEY = ['ssh'] as const;
const HOSTS_KEY = [...SSH_KEY, 'hosts'] as const;
const KNOWN_HOSTS_KEY = [...SSH_KEY, 'known-hosts'] as const;

/**
 * The stored hosts, in the order the store keeps them.
 *
 * The list is read from the device, so no connection is involved:
 * `networkMode: 'always'` keeps React Query from withholding the read while the
 * app reports itself offline.
 */
export function useSshHosts() {
  return useQuery({
    queryKey: HOSTS_KEY,
    networkMode: 'always',
    queryFn: async () => listHosts(await sshDatabase()),
  });
}

/** The keys a host can authenticate with, for the editor's picker. */
export function useSshKnownHosts() {
  return useQuery({
    queryKey: KNOWN_HOSTS_KEY,
    networkMode: 'always',
    queryFn: async () => listKnownHosts(await sshDatabase()),
  });
}

/**
 * What the host editor needs, read in one pass: the host being edited (null
 * when it is a new one), every host the jump picker can offer, and the keys the
 * key picker can offer.
 */
export function useSshHostEditor(hostId: string | null) {
  return useQuery({
    queryKey: [...SSH_KEY, 'editor', hostId],
    networkMode: 'always',
    queryFn: async () => {
      const db = await sshDatabase();
      return {
        host: hostId === null ? null : getHost(db, hostId),
        hosts: listHosts(db),
        keys: listKeys(db),
      };
    },
  });
}

function useSshInvalidation() {
  const client = useQueryClient();
  return useCallback(() => client.invalidateQueries({ queryKey: SSH_KEY }), [client]);
}

export function useSshHostMutations() {
  const invalidate = useSshInvalidation();
  const save = useMutation({
    mutationFn: async (input: { id: string | null; host: SshHostInput }) => {
      const db = await sshDatabase();
      return input.id === null ? createHost(db, input.host) : updateHost(db, input.id, input.host);
    },
    onSuccess: () => void invalidate(),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      deleteHost(await sshDatabase(), id);
    },
    onSuccess: () => void invalidate(),
  });
  return { save, remove };
}

export function useSshKnownHostMutations() {
  const invalidate = useSshInvalidation();
  const remove = useMutation({
    mutationFn: async (id: string) => {
      removeKnownHost(await sshDatabase(), id);
    },
    onSuccess: () => void invalidate(),
  });
  return { remove };
}

export function useSshConfigImport() {
  const invalidate = useSshInvalidation();
  return useMutation({
    mutationFn: async (plan: SshConfigPlan) => importSshConfig(await sshDatabase(), plan),
    onSuccess: () => void invalidate(),
  });
}
