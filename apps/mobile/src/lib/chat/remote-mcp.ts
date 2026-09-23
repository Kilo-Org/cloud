import { Effect } from 'effect';
import { type Tool } from '@kilocode/harness-sdk';
import {
  type RemoteMcpClientDeps,
  RemoteMcpError,
  type RemoteMcpServer,
  remoteMcpTools,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';

import {
  listRemoteMcpServers,
  type StoredRemoteMcpServer,
  subscribeRemoteMcpServers,
} from './remote-mcp-store';
import { type ChatPlace } from './scope';

/**
 * The remote MCP servers a person added, discovered for the tools they offer.
 *
 * The app owns the list (see `remote-mcp-store.ts`); the harness knows one
 * server at a time and discovers what it offers. This module is the join: it
 * reads the stored list, connects to each enabled server with the SDK's
 * `remoteMcpTools`, and keeps the answer per server so a screen can draw it and
 * a session can be opened with the names.
 *
 * The token is never held here. It is read from the stored server by id each
 * time the accessor is asked, so a rotated one is used rather than the one
 * captured at discovery, and a discovery is cached against the config and the
 * auth epoch — never against a token. A disabled server contributes no tool
 * and no name, and its cached tools are dropped the moment it is disabled.
 *
 * The token is never logged.
 */

/** Why a server's tools are, or are not, on hand. */
export type RemoteMcpStatus = 'idle' | 'connecting' | 'ready' | 'failed';

/** One server's discovery result, keyed by the server's id. */
export type RemoteMcpDiscovery = {
  readonly tools: readonly Tool[];
  /** True when the discovery did not reach the server, so none of its tools are offered. */
  readonly failed?: boolean;
};

/** What one server looks like to whoever draws it. */
export type RemoteMcpServerState = {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly enabled: boolean;
  readonly status: RemoteMcpStatus;
  readonly toolCount: number;
  readonly retryable: boolean;
};

/**
 * Whether a discovery is the one an open makes or the one a person asked for.
 * A Retry gets the longer deadline because the person is waiting on it, and the
 * failure is the thing being given another chance.
 */
export type RemoteMcpRequest = {
  readonly retry?: boolean;
};

const AUTOMATIC_TIMEOUT_MS = 4000;
const RETRY_TIMEOUT_MS = 15_000;

/** The deadline one discovery gets: the Retry's is the caller's own ask. */
const deadlineFor = (request: RemoteMcpRequest): number =>
  request.retry === true ? RETRY_TIMEOUT_MS : AUTOMATIC_TIMEOUT_MS;

/** The state a server is drawn in, with every field named once. */
function stateOf(
  server: StoredRemoteMcpServer,
  fields: {
    readonly status: RemoteMcpStatus;
    readonly toolCount: number;
    readonly retryable: boolean;
  }
): RemoteMcpServerState {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    enabled: server.enabled,
    status: fields.status,
    toolCount: fields.toolCount,
    retryable: fields.retryable,
  };
}

/**
 * The state of every stored server, joined with what has been discovered.
 *
 * A disabled server is always `idle` with no tools, whatever a stale entry
 * says: it is the list that decides, and the entry is left for `reconcile` to
 * drop. A server with no entry has not been asked yet. A failed discovery shows
 * as `failed` with no tools, so a screen offers a Retry rather than counting a
 * list that answers nothing.
 */
export function remoteServerStates(
  servers: readonly StoredRemoteMcpServer[],
  discovered: ReadonlyMap<string, RemoteMcpDiscovery>
): RemoteMcpServerState[] {
  return servers.map(server => {
    if (!server.enabled) {
      return stateOf(server, { status: 'idle', toolCount: 0, retryable: false });
    }
    const found = discovered.get(server.id);
    if (found === undefined) {
      return stateOf(server, { status: 'idle', toolCount: 0, retryable: false });
    }
    if (found.failed === true) {
      return stateOf(server, { status: 'failed', toolCount: 0, retryable: true });
    }
    return stateOf(server, { status: 'ready', toolCount: found.tools.length, retryable: false });
  });
}

/**
 * The tools of the enabled servers that were discovered, in list order.
 *
 * A disabled server contributes nothing even if it has a cached entry, and a
 * failed discovery contributes nothing even when it answered with tools
 * earlier: the union is only ever a server the app can currently reach.
 */
export function remoteServerToolsFor(
  servers: readonly StoredRemoteMcpServer[],
  discovered: ReadonlyMap<string, RemoteMcpDiscovery>
): readonly Tool[] {
  return servers.flatMap(server => {
    const found = server.enabled ? discovered.get(server.id) : undefined;
    return found === undefined || found.failed === true ? [] : found.tools;
  });
}

/** The snapshot React draws. Replaced whole, so a watcher can compare it by reference. */
let snapshot: readonly RemoteMcpServerState[] = [];
const listeners = new Set<() => void>();

/** The servers whose discovery is running now, which is what `connecting` means. */
const pending = new Set<string>();

/** What has been discovered, valid for `cacheKey` only. Keyed by server id. */
let discovered = new Map<string, RemoteMcpDiscovery>();

/** The config and account the current `discovered` map belongs to. */
let cacheKey: string | undefined = undefined;

/** The discovery already running for one key, so two callers do not both connect. */
let inFlight: { readonly key: string; readonly promise: Promise<void> } | undefined = undefined;

/**
 * Bumped by `forgetRemoteMcp` and by a config or account change, so a discovery
 * that outlived either cannot publish over the state that now holds.
 */
let generation = 0;

/** Whether a server is still in the list and enabled, which a late answer may not assume. */
function stillEnabled(id: string): boolean {
  return listRemoteMcpServers().some(server => server.id === id && server.enabled);
}

/** Which config and account a discovery belongs to. A token is never part of it. */
function keyFor(place: ChatPlace): string {
  const config = listRemoteMcpServers()
    .map(
      server =>
        `${server.id}\u001F${server.url}\u001F${server.auth.type}\u001F${server.enabled ? '1' : '0'}`
    )
    .join('\u001E');
  return `${place.chatScope}\u0000${String(currentAuthEpoch())}\u0000${config}`;
}

/** The server as the SDK knows it: an id, a name, a URL and how it wants a credential. */
function serverValue(server: StoredRemoteMcpServer): RemoteMcpServer {
  return {
    id: server.id,
    name: server.name,
    url: server.url,
    auth: { type: server.auth.type },
  };
}

/**
 * The credential for one call, asked each time so a rotated token is used
 * instead of the one captured at discovery. A server that wants none has no
 * accessor. A bearer server whose stored token is gone is reported as
 * unauthorized rather than as an anonymous request.
 */
function tokenOf(serverId: string): Effect.Effect<string, RemoteMcpError> {
  const stored = listRemoteMcpServers().find(entry => entry.id === serverId);
  const token = stored?.auth.type === 'bearer' ? stored.auth.token : undefined;
  if (token === undefined) {
    return Effect.fail(
      new RemoteMcpError({ serverId, kind: 'unauthorized', cause: 'the stored token is gone' })
    );
  }
  return Effect.succeed(token);
}

function tokenFor(
  server: StoredRemoteMcpServer
): (() => Effect.Effect<string, RemoteMcpError>) | undefined {
  if (server.auth.type !== 'bearer') {
    return undefined;
  }
  const serverId = server.id;
  return () => tokenOf(serverId);
}

/** The deps one discovery runs with, with the token omitted for a server that wants none. */
function depsFor(
  server: StoredRemoteMcpServer,
  timeoutMs: number,
  started: number
): RemoteMcpClientDeps {
  const deps: RemoteMcpClientDeps = {
    fetch,
    discoverTimeoutMs: timeoutMs,
    onCallFailure: lostConnection(server.id, started),
  };
  const token = tokenFor(server);
  return token === undefined ? deps : { ...deps, token };
}

/**
 * A call that did not reach the server, published as that server's failure.
 *
 * The answer that just stopped being true is dropped rather than covered up:
 * a discovery is served from `discovered` and the whole point of the Retry is
 * to reach the server again. A sign-out, or a server disabled while the call
 * was out, wins: its failure is not published.
 */
function lostConnection(serverId: string, started: number): () => void {
  return () => {
    if (started !== generation || !stillEnabled(serverId)) {
      return;
    }
    discovered.set(serverId, { tools: [], failed: true });
    pending.delete(serverId);
    publish();
  };
}

/** One server's discovery, recorded where a screen and a session can read it. */
async function discover(
  server: StoredRemoteMcpServer,
  timeoutMs: number,
  started: number
): Promise<void> {
  const outcome = await Effect.runPromise(
    remoteMcpTools(serverValue(server), depsFor(server, timeoutMs, started)).pipe(
      Effect.match({
        onFailure: (error: RemoteMcpError) => ({ ok: false as const, error }),
        onSuccess: (tools: readonly Tool[]) => ({ ok: true as const, tools }),
      }),
      Effect.catchAllCause(cause =>
        Effect.succeed({
          ok: false as const,
          error: new RemoteMcpError({ serverId: server.id, kind: 'unreachable', cause }),
        })
      )
    )
  );
  /* A sign-out, or an edit to the server, between the request and the answer
     dropped the connection or superseded it. What the old server answered must
     not be published under the new one, and its `pending` entry must not be
     cleared: that entry now belongs to the discovery the new key started. */
  if (started !== generation) {
    return;
  }
  pending.delete(server.id);
  if (!stillEnabled(server.id)) {
    publish();
    return;
  }
  discovered.set(server.id, outcome.ok ? { tools: outcome.tools } : { tools: [], failed: true });
  publish();
}

/** The same server, drawn as one whose discovery is running now. */
function connectingOf(state: RemoteMcpServerState): RemoteMcpServerState {
  return {
    id: state.id,
    name: state.name,
    url: state.url,
    enabled: state.enabled,
    status: 'connecting',
    toolCount: 0,
    retryable: false,
  };
}

/** The states the module holds, with a running discovery shown as `connecting`. */
function currentStates(): RemoteMcpServerState[] {
  const states = remoteServerStates(listRemoteMcpServers(), discovered);
  return states.map(state =>
    pending.has(state.id) && state.status === 'idle' ? connectingOf(state) : state
  );
}

/** Replaces the snapshot and wakes every watcher. */
function publish(): void {
  snapshot = currentStates();
  for (const listener of listeners) {
    listener();
  }
}

/** Drops entries for servers that are gone or were disabled, which is a store change. */
function reconcile(): void {
  const enabled = new Set(
    listRemoteMcpServers()
      .filter(server => server.enabled)
      .map(server => server.id)
  );
  for (const id of discovered.keys()) {
    if (!enabled.has(id)) {
      discovered.delete(id);
    }
  }
  for (const id of pending) {
    if (!enabled.has(id)) {
      pending.delete(id);
    }
  }
}

/**
 * Whether an entry is the answer a later ask may reuse.
 *
 * A server that named tools keeps them for the config and the account, so the
 * next chat does not open a second connection for the same list. A server that
 * answered with none is the one answer that must be asked again: the empty
 * state offers no Retry of its own, so a catalog that was mid-deploy when the
 * first chat asked would leave every chat after it on no tools until the app
 * was restarted. The next ask reconnects and says what the server offers now.
 */
function reusable(found: RemoteMcpDiscovery | undefined): boolean {
  return found !== undefined && found.failed !== true && found.tools.length > 0;
}

/**
 * Discovers the enabled servers' tools, reusing the answers already made for the
 * same config and account.
 *
 * A discovery that failed is not an answer: asking again reconnects, which is
 * what a Retry and the next chat both are. Neither is an answer with no tools in
 * it, because the empty list offers no Retry and the next ask is what makes a
 * transient empty catalog recoverable. A call made while one is already running
 * for the same key joins it rather than opening a second connection.
 */
export async function ensureRemoteMcp(
  place: ChatPlace,
  request: RemoteMcpRequest = {}
): Promise<readonly RemoteMcpServerState[]> {
  const key = keyFor(place);
  if (key !== cacheKey) {
    /* The config or the account changed, so a discovery started for the old one
       is no longer the answer: bumping the generation stops it publishing its
       server's tools over the discovery the new key now runs, and stops it
       clearing that discovery's `pending`. */
    generation += 1;
    cacheKey = key;
    discovered = new Map();
    pending.clear();
    publish();
  }
  const missing = listRemoteMcpServers()
    .filter(server => server.enabled)
    .filter(server => !reusable(discovered.get(server.id)));
  if (missing.length === 0) {
    return snapshot;
  }
  if (inFlight?.key === key) {
    await inFlight.promise;
    return snapshot;
  }
  for (const server of missing) {
    discovered.delete(server.id);
    pending.add(server.id);
  }
  publish();
  const started = generation;
  const discoveries: Promise<void>[] = [];
  for (const server of missing) {
    discoveries.push(discover(server, deadlineFor(request), started));
  }
  const promise = (async () => {
    await Promise.all(discoveries);
  })();
  const entry = { key, promise };
  inFlight = entry;
  try {
    await promise;
  } finally {
    if (inFlight === entry) {
      inFlight = undefined;
    }
  }
  return snapshot;
}

/** The snapshot a screen draws: one entry per stored server, whether or not it is discovered. */
export function remoteMcpState(): readonly RemoteMcpServerState[] {
  return snapshot;
}

/** The union of the enabled servers' discovered tools, which is what a registry is built from. */
export function remoteServerTools(): readonly Tool[] {
  return remoteServerToolsFor(listRemoteMcpServers(), discovered);
}

/** The names of those tools, which is what a session is opened with. */
export function remoteServerToolNames(): readonly string[] {
  return remoteServerTools().map(tool => tool.definition.name);
}

/** Watches the snapshot, the way a screen subscribes to a chat. */
export function subscribeRemoteMcp(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drops the connection now: no discovered tools and no cached identity survive,
 * and a discovery still running cannot publish over the next account.
 */
export function forgetRemoteMcp(): void {
  generation += 1;
  cacheKey = undefined;
  discovered = new Map();
  pending.clear();
  inFlight = undefined;
  publish();
}

// The list is the app's own, so a change to it — an add, an edit, a delete, an
// enable or a disable — is what makes the discovered state stale. A disabled
// server's tools are dropped here, at the moment it is disabled.
subscribeRemoteMcpServers(() => {
  reconcile();
  publish();
});
publish();
