import { type StoredRemoteMcpServer } from './remote-mcp-store';

/**
 * `remote-mcp.ts` holds the discovery and the answers; these are the records that
 * say which of them a change to the stored list has made stale.
 */

/** The discovery running for one server, and the config and generation it is for. */
export type DiscoveryAttempt = { readonly generation: number; readonly config: string };

/** The config each server's answer and attempt were made for, keyed by id. */
export const observedConfigs = new Map<string, string>();

/** The discoveries running now, which is what `connecting` means for a server. */
export const attempts = new Map<string, DiscoveryAttempt>();

/**
 * What one server's answer is valid for: its endpoint, its auth type and whether
 * it is on. The stored id is the map key and a token is never part of it.
 */
export function configOf(server: StoredRemoteMcpServer): string {
  return `${server.url}\u001F${server.auth.type}\u001F${server.enabled ? '1' : '0'}`;
}

/**
 * Reconciles the recorded configs against the stored list, per server.
 *
 * Only the config a server's answer was made for moving on makes that answer
 * stale, so the returned ids are the only ones the caller may drop, and every
 * other server keeps its tools, its views and its running discovery. A server
 * that moved on loses its attempt too, and one that is gone loses its rows here
 * and is returned so its answer goes with them.
 */
export function reconcile(servers: readonly StoredRemoteMcpServer[]): readonly string[] {
  const stored = new Set<string>();
  const stale: string[] = [];
  for (const server of servers) {
    stored.add(server.id);
    const config = configOf(server);
    if (observedConfigs.get(server.id) !== config) {
      attempts.delete(server.id);
      observedConfigs.set(server.id, config);
      stale.push(server.id);
    }
  }
  for (const id of observedConfigs.keys()) {
    if (!stored.has(id)) {
      attempts.delete(id);
      observedConfigs.delete(id);
      stale.push(id);
    }
  }
  return stale;
}

/** Drops every recorded config and attempt, as a sign-out or a changed account does. */
export function forgetCache(): void {
  observedConfigs.clear();
  attempts.clear();
}
