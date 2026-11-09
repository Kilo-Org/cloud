import { Effect } from 'effect';
import { type Tool } from '@kilocode/harness-sdk';
import {
  type RemoteMcpApp,
  type RemoteMcpAppContext,
  type RemoteMcpClientDeps,
  RemoteMcpError,
  type RemoteMcpOfferedTool,
  remoteMcpTools,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { getCommittedConnectivityStatus } from '@/lib/hooks/use-offline-banner-state';

import { forgetCallResults, rememberCallResult } from './remote-mcp-call-results';
import { credentialDeps, serverValue } from './remote-mcp-credentials';
import {
  connectingOf,
  discoveryOf,
  type RemoteMcpDiscovery,
  type RemoteMcpServerState,
  type RemoteMcpToolView,
  remoteServerStates,
  remoteServerToolsFor,
  remoteServerViewsFor,
} from './remote-mcp-state';
import {
  openViewBridge,
  readViewDocument,
  type RemoteMcpViewDocument,
  type RemoteMcpViewSource,
} from './remote-mcp-views';
import {
  getRemoteMcpServersHasLoaded,
  listRemoteMcpServers,
  type StoredRemoteMcpServer,
  subscribeRemoteMcpServers,
  whenRemoteMcpServersLoaded,
} from './remote-mcp-store';
import { publishRemoteMcpViews } from './remote-mcp-surface';
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
 * The token is never held here (see `remote-mcp-credentials.ts`). It is read from the stored server by id each
 * time the accessor is asked, so a rotated one is used rather than the one
 * captured at discovery, and a discovery is cached against the config and the
 * auth epoch — never against a token. A disabled server contributes no tool
 * and no name, and its cached tools are dropped the moment it is disabled.
 *
 * The token is never logged.
 */

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

/**
 * A view's document is read while the row that draws it is on screen, so it is
 * bounded like a discovery rather than like a tool call: a server that does not
 * answer leaves the row with its Retry, not a minute of waiting.
 */
const VIEW_READ_TIMEOUT_MS = 15_000;

/** The deadline one discovery gets: the Retry's is the caller's own ask. */
const deadlineFor = (request: RemoteMcpRequest): number =>
  request.retry === true ? RETRY_TIMEOUT_MS : AUTOMATIC_TIMEOUT_MS;

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

/** The deps one discovery runs with. */
function depsFor(
  server: StoredRemoteMcpServer,
  timeoutMs: number,
  started: number
): RemoteMcpClientDeps {
  return {
    fetch,
    discoverTimeoutMs: timeoutMs,
    onCallFailure: lostConnection(server, started),
    onCallResult: rememberCallResult,
    ...credentialDeps(server),
  };
}

/** What a failed discovery or call leaves: an OAuth server that refused needs a person. */
function failureOf(server: StoredRemoteMcpServer, error: RemoteMcpError): RemoteMcpDiscovery {
  const nothing = { tools: [], views: new Map<string, RemoteMcpToolView>(), serverTools: [] };
  return server.auth.type === 'oauth' && error.kind === 'unauthorized'
    ? { ...nothing, failed: true, signIn: true }
    : { ...nothing, failed: true };
}

/**
 * A call that did not reach the server, published as that server's failure.
 *
 * The answer that just stopped being true is dropped rather than covered up:
 * a discovery is served from `discovered` and the whole point of the Retry is
 * to reach the server again. A sign-out, or a server disabled while the call
 * was out, wins: its failure is not published.
 */
function lostConnection(
  server: StoredRemoteMcpServer,
  started: number
): (error: RemoteMcpError) => void {
  return error => {
    if (started !== generation || !stillEnabled(server.id)) {
      return;
    }
    discovered.set(server.id, failureOf(server, error));
    pending.delete(server.id);
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
        onSuccess: (tools: readonly RemoteMcpOfferedTool[]) => ({ ok: true as const, tools }),
      }),
      Effect.catchCause(cause =>
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
  discovered.set(
    server.id,
    outcome.ok ? discoveryOf(server.id, outcome.tools) : failureOf(server, outcome.error)
  );
  publish();
}

/** The states the module holds, with a running discovery shown as `connecting`. */
function currentStates(): RemoteMcpServerState[] {
  const states = remoteServerStates(listRemoteMcpServers(), discovered);
  return states.map(state =>
    pending.has(state.id) && state.status === 'idle' ? connectingOf(state) : state
  );
}

/** Replaces the snapshot, the view lookup and wakes every watcher. */
function publish(): void {
  snapshot = currentStates();
  publishRemoteMcpViews(remoteServerViewsFor(listRemoteMcpServers(), discovered));
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
 * answered with none is asked again: a catalog that was mid-deploy when the
 * first chat asked would otherwise leave every chat after it on no tools until
 * the app was restarted. The next ask reconnects and says what the server
 * offers now.
 */
function reusable(found: RemoteMcpDiscovery | undefined): boolean {
  return found !== undefined && found.failed !== true && found.tools.length > 0;
}

/**
 * The servers an automatic ask found offline, recorded as failed rather than
 * connected to: the row offers a Retry, and the next open asks them again.
 */
function failOffline(servers: readonly StoredRemoteMcpServer[]): readonly RemoteMcpServerState[] {
  for (const server of servers) {
    discovered.set(server.id, {
      tools: [],
      views: new Map(),
      serverTools: [],
      failed: true,
    });
  }
  publish();
  return snapshot;
}

/**
 * Discovers the enabled servers' tools, reusing the answers already made for the
 * same config and account.
 *
 * A discovery that failed is not an answer: asking again reconnects, which is
 * what a Retry and the next chat both are. Neither is an answer with no tools in
 * it, because the next ask is what makes a transient empty catalog recoverable.
 * A call made while one is already running for the same key joins it rather
 * than opening a second connection.
 *
 * After a cold start the stored list may not have been read yet, and an empty
 * list then means "not read" rather than "none": the ask waits for it, or a
 * chat opened at launch would discover nothing. An automatic ask made while
 * the app has confirmed it is offline connects to nothing, so a chat opens at
 * once rather than after the deadline. An unknown state, as at boot before
 * NetInfo settles, still connects; a person's Retry always tries.
 */
export async function ensureRemoteMcp(
  place: ChatPlace,
  request: RemoteMcpRequest = {}
): Promise<readonly RemoteMcpServerState[]> {
  if (!getRemoteMcpServersHasLoaded()) {
    await whenRemoteMcpServersLoaded();
  }
  const key = keyFor(place);
  if (key !== cacheKey) {
    /* The config or the account changed, so a discovery started for the old one
       is no longer the answer: bumping the generation stops it publishing its
       server's tools over the discovery the new key now runs, and stops it
       clearing that discovery's `pending`. */
    generation += 1;
    cacheKey = key;
    discovered = new Map();
    forgetCallResults();
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
  if (request.retry !== true && getCommittedConnectivityStatus() === 'offline') {
    return failOffline(missing);
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

/** The source a view is read and driven from: the server, its deps and its tools. */
function viewSourceOf(view: RemoteMcpToolView): RemoteMcpViewSource | undefined {
  const server = listRemoteMcpServers().find(held => held.id === view.serverId && held.enabled);
  const found = server === undefined ? undefined : discovered.get(server.id);
  if (server === undefined || found === undefined || found.failed === true) {
    return undefined;
  }
  const deps = depsFor(server, AUTOMATIC_TIMEOUT_MS, generation);
  return { server: serverValue(server), deps, tools: found.serverTools };
}

/**
 * The document a tool's view is drawn from, held to the policy it declared.
 * `signal` ends the read with the row that asked for it.
 */
export async function readRemoteMcpView(
  view: RemoteMcpToolView,
  signal?: AbortSignal
): Promise<RemoteMcpViewDocument> {
  const source = viewSourceOf(view);
  if (source === undefined) {
    return { kind: 'unavailable' };
  }
  /* A read is not a call: a row that scrolls away aborts it, and a read the
     person's own row cancelled must not be published as that server failing —
     which is what the deps' `onCallFailure` would do. The row's own Retry is
     where a read that did not answer is reported. */
  const deps: RemoteMcpClientDeps = {
    ...source.deps,
    timeoutMs: VIEW_READ_TIMEOUT_MS,
    signal,
  };
  delete deps.onCallFailure;
  const document = await readViewDocument({ ...source, deps }, view);
  return document;
}

/** The bridge for one tool's view, over the same client a model's calls use. */
export function openRemoteMcpApp(
  view: RemoteMcpToolView,
  options: { readonly context?: RemoteMcpAppContext; readonly openLink?: (uri: string) => void }
): RemoteMcpApp | undefined {
  const source = viewSourceOf(view);
  return source === undefined ? undefined : openViewBridge(source, options);
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
  forgetCallResults();
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
