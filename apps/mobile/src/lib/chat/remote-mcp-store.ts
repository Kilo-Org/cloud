import { useSyncExternalStore } from 'react';
import { z } from 'zod';

import { createSecureStorePreference } from '@/lib/hooks/secure-store-preference';
import { REMOTE_MCP_SERVERS_KEY } from '@/lib/storage-keys';

import { normalizeRemoteMcpUrl } from './remote-mcp-url';

/**
 * The remote MCP servers the user added, and the one place they are written.
 *
 * The app owns the list, not the harness: the SDK is handed one server at a
 * time and knows nothing about a list, an order, an edit or a delete. So the
 * list lives here, on the account-scoped secure store, and both the settings
 * screen and an agent tool call read and write this one value.
 *
 * `id` is not decoration. The harness names a server's tools `mcp_<id>_<tool>`,
 * so the id is part of every tool name a model reads; it is a callable-name
 * slug of the name, uniquified against the stored ids, and it is stable across
 * an edit so a rename does not churn the model's tool list.
 */

/** How a server is authorized. The token is optional: `bearer` may name it later. */
export type RemoteMcpAuth = { type: 'none' } | { type: 'bearer'; token?: string };

/** One stored server. `id` is the callable-name part of every tool name it offers. */
export type StoredRemoteMcpServer = {
  id: string;
  name: string;
  url: string;
  auth: RemoteMcpAuth;
  enabled: boolean;
};

/** What a caller hands over to add or edit a server. `id` is ignored on add when taken. */
export type RemoteMcpServerDraft = Pick<
  StoredRemoteMcpServer,
  'name' | 'url' | 'auth' | 'enabled'
> & { id?: string };

/** The fields an edit may change. The id is the handle, not a field. */
export type RemoteMcpServerPatch = Partial<Omit<StoredRemoteMcpServer, 'id'>>;

/** A server id is part of a tool name a model must be able to write. */
const CALLABLE_ID = /^[A-Za-z0-9_-]+$/u;

const remoteMcpAuthSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('none') }).strip(),
  z.object({ type: z.literal('bearer'), token: z.string().optional() }).strip(),
]);

const storedRemoteMcpServerSchema = z
  .object({
    id: z.string().regex(CALLABLE_ID),
    name: z.string(),
    url: z.string(),
    auth: remoteMcpAuthSchema,
    enabled: z.boolean(),
  })
  .strip();

/**
 * The callable-name slug of a server name: lowercase, non-alphanumerics to `-`,
 * no leading or trailing `-`. A name with no alphanumerics still gets one.
 */
function slugFor(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '');
  return slug.length > 0 ? slug : 'remote-mcp';
}

/**
 * A unique id for a new server. A name shared with an existing server gets a
 * numeric suffix, because two servers with one id would map their tools to the
 * same names and silently drop each other.
 */
function resolveServerId(
  name: string,
  requested: string | undefined,
  servers: readonly StoredRemoteMcpServer[]
): string {
  const taken = new Set(servers.map(server => server.id));
  if (requested !== undefined && CALLABLE_ID.test(requested) && !taken.has(requested)) {
    return requested;
  }
  const base = slugFor(name);
  if (!taken.has(base)) {
    return base;
  }
  let suffix = 2;
  while (taken.has(`${base}-${suffix}`)) {
    suffix += 1;
  }
  return `${base}-${suffix}`;
}

/** A stored URL is normalized on the way in; an unnormalizable one is dropped. */
function normalizeStoredUrl(url: string): string | undefined {
  try {
    return normalizeRemoteMcpUrl(url);
  } catch {
    return undefined;
  }
}

/**
 * Parse entries independently so one corrupt server cannot erase healthy
 * servers and their bearer tokens on the next write.
 */
export function parseRemoteMcpServers(raw: string | null): StoredRemoteMcpServer[] {
  if (raw === null) {
    return [];
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return [];
    }
    const servers: StoredRemoteMcpServer[] = [];
    const ids = new Set<string>();
    const urls = new Set<string>();
    for (const entry of parsed) {
      const result = storedRemoteMcpServerSchema.safeParse(entry);
      if (result.success) {
        const server = result.data;
        const url = normalizeStoredUrl(server.url);
        if (url !== undefined && !ids.has(server.id) && !urls.has(url)) {
          ids.add(server.id);
          urls.add(url);
          servers.push({ ...server, url });
        }
      }
    }
    return servers;
  } catch {
    // Malformed JSON is a corrupt write, not a crash.
    return [];
  }
}

/**
 * Reconciles a write that raced the initial disk read: the persisted list keeps
 * its order, a pending server replaces the stored one with the same id, and a
 * pending server the disk does not know is appended.
 */
function mergeRemoteMcpServers(
  disk: StoredRemoteMcpServer[],
  pending: StoredRemoteMcpServer[]
): StoredRemoteMcpServer[] {
  const merged = [...disk];
  for (const server of pending) {
    const index = merged.findIndex(current => current.id === server.id);
    if (index === -1) {
      merged.push(server);
    } else {
      merged[index] = server;
    }
  }
  return merged;
}

const store = createSecureStorePreference<StoredRemoteMcpServer[]>({
  key: REMOTE_MCP_SERVERS_KEY,
  defaultValue: [],
  parse: parseRemoteMcpServers,
  serialize: value => JSON.stringify(value),
  mergeOnLoad: mergeRemoteMcpServers,
});

// Warm the disk read at module scope so a settings screen and an agent tool
// call see the persisted list without waiting for a React mount.
store.preload();

/** The stored servers, in the order they were added. */
export function listRemoteMcpServers(): StoredRemoteMcpServer[] {
  return store.get();
}

/**
 * Adds a server and returns it. The id is derived from the name, uniquified
 * against the stored ids. A URL another server already uses is refused, because
 * two rows pointing at one endpoint is a user mistake, not two servers.
 */
export function addRemoteMcpServer(draft: RemoteMcpServerDraft): StoredRemoteMcpServer {
  const current = store.get();
  const url = normalizeRemoteMcpUrl(draft.url);
  if (current.some(server => server.url === url)) {
    throw new Error('Remote MCP URL is already saved.');
  }
  const server: StoredRemoteMcpServer = {
    id: resolveServerId(draft.name, draft.id, current),
    name: draft.name,
    url,
    auth: draft.auth,
    enabled: draft.enabled,
  };
  store.set([...current, server]);
  return server;
}

/**
 * Replaces one server in place, keeping its id and its position in the list.
 * A rename does not change the id, so the tool names the model already read
 * stay the same. A URL another server already uses is refused.
 */
export function updateRemoteMcpServer(
  id: string,
  patch: RemoteMcpServerPatch
): StoredRemoteMcpServer {
  const current = store.get();
  const existing = current.find(server => server.id === id);
  if (existing === undefined) {
    throw new Error('Remote MCP server not found.');
  }
  const url = normalizeRemoteMcpUrl(patch.url ?? existing.url);
  if (current.some(server => server.id !== id && server.url === url)) {
    throw new Error('Remote MCP URL is already saved.');
  }
  const updated: StoredRemoteMcpServer = {
    id,
    name: patch.name ?? existing.name,
    url,
    auth: patch.auth ?? existing.auth,
    enabled: patch.enabled ?? existing.enabled,
  };
  store.set(current.map(server => (server.id === id ? updated : server)));
  return updated;
}

/** Removes one server and returns it. */
export function deleteRemoteMcpServer(id: string): StoredRemoteMcpServer {
  const current = store.get();
  const removed = current.find(server => server.id === id);
  if (removed === undefined) {
    throw new Error('Remote MCP server not found.');
  }
  store.set(current.filter(server => server.id !== id));
  return removed;
}

/** Flips one server's enabled flag and leaves every other server untouched. */
export function setRemoteMcpServerEnabled(id: string, enabled: boolean): StoredRemoteMcpServer {
  const current = store.get();
  const existing = current.find(server => server.id === id);
  if (existing === undefined) {
    throw new Error('Remote MCP server not found.');
  }
  const updated: StoredRemoteMcpServer = { ...existing, enabled };
  store.set(current.map(server => (server.id === id ? updated : server)));
  return updated;
}

/** Watches the list, the way a screen subscribes to a chat. */
export function subscribeRemoteMcpServers(listener: () => void): () => void {
  return store.subscribe(listener);
}

/**
 * Whether the persisted list has been read yet.
 *
 * Until it has, the store's value is the empty default, so an empty list means
 * "not read" rather than "none": a screen that draws the empty state from
 * `length === 0` alone would flash "no servers" at a returning user whose list
 * is still on disk.
 */
export function getRemoteMcpServersHasLoaded(): boolean {
  return store.getHasLoaded();
}

/** The list a screen draws. */
export function useRemoteMcpServers(): StoredRemoteMcpServer[] {
  return useSyncExternalStore(store.subscribe, store.get);
}

/** Drops every server from memory and disk, which is what signing out does. */
export function clearRemoteMcpServers(): void {
  store.clear();
}
