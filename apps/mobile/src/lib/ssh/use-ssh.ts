import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback } from 'react';
import { toast } from 'sonner-native';

import { importSshConfig, type SshConfigPlan } from './config-import';
import { createHost, deleteHost, getHost, listHosts, type SshHostInput, updateHost } from './hosts';
import { createKey, listKeys, type SshKeyInput } from './keys';
import { listKnownHosts, removeKnownHost } from './known-hosts';
import {
  createSnippet,
  deleteSnippet,
  listSnippets,
  reorderSnippets,
  updateSnippet,
} from './snippets';
import { sshDatabase } from './store';

/** Every ssh query lives under this key, so one invalidation refreshes a screen. */
export const SSH_KEY = ['ssh'] as const;
const HOSTS_KEY = [...SSH_KEY, 'hosts'] as const;
const KNOWN_HOSTS_KEY = [...SSH_KEY, 'known-hosts'] as const;
const SNIPPETS_KEY = [...SSH_KEY, 'snippets'] as const;

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
 * Every stored snippet in the store's own order. A terminal shows the global
 * ones plus its host's; the manage screen shows them all.
 */
export function useSshSnippets() {
  return useQuery({
    queryKey: SNIPPETS_KEY,
    networkMode: 'always',
    queryFn: async () => listSnippets(await sshDatabase()),
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

/** The one invalidator every ssh mutation shares. */
export function useSshInvalidation() {
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

export function useSshKeyMutations() {
  const invalidate = useSshInvalidation();
  const create = useMutation({
    mutationFn: async (input: SshKeyInput) => createKey(await sshDatabase(), input),
    onSuccess: () => void invalidate(),
    onError: error => toast.error(error.message),
  });
  return { create };
}

type SaveSnippetInput = Readonly<{
  /** The snippet being edited; null creates one. */
  id: string | null;
  label: string;
  command: string;
  appendNewline: boolean;
  /** The snippet's host, or null for a snippet every host offers. */
  hostId: string | null;
  /** Where a new snippet lands in the store's order. */
  sortOrder: number;
}>;

export function useSshSnippetMutations() {
  const invalidate = useSshInvalidation();
  const save = useMutation({
    mutationFn: async (input: SaveSnippetInput) => {
      const db = await sshDatabase();
      return input.id === null ? createSnippet(db, input) : updateSnippet(db, input.id, input);
    },
    onSuccess: () => void invalidate(),
    onError: error => toast.error(error.message),
  });
  const remove = useMutation({
    mutationFn: async (id: string) => {
      deleteSnippet(await sshDatabase(), id);
    },
    onSuccess: () => void invalidate(),
    onError: error => toast.error(error.message),
  });
  const reorder = useMutation({
    mutationFn: async (orderedIds: readonly string[]) => {
      reorderSnippets(await sshDatabase(), orderedIds);
    },
    onSuccess: () => void invalidate(),
    onError: error => toast.error(error.message),
  });
  return { save, remove, reorder };
}

export function useSshConfigImport() {
  const invalidate = useSshInvalidation();
  return useMutation({
    mutationFn: async (plan: SshConfigPlan) => importSshConfig(await sshDatabase(), plan),
    onSuccess: () => void invalidate(),
  });
}
