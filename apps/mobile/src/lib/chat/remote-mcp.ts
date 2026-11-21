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
import { connectionRefusesWrites } from '@/lib/hooks/use-offline-banner-state';

import { forgetCallResults, rememberCallResult } from './remote-mcp-call-results';
import {
  attempts,
  configOf,
  type DiscoveryAttempt,
  forgetCache,
  observedConfigs,
  reconcile,
} from './remote-mcp-cache';
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
 * captured at discovery, and a discovery is cached against its own server's
 * config — never against a token, never against the account alone. A disabled
 * server contributes no tool and no name, and its cached tools are dropped the
 * moment it is disabled. A change to one server invalidates that server only:
 * the other servers keep their tools, their views and their in-flight
 * discoveries.
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

/** What has been discovered, keyed by server id and valid for that server's observed config. */
let discovered = new Map<string, RemoteMcpDiscovery>();

/** The account and place the current `discovered` map and every recorded config belong to. */
let scopeKey: string | undefined = undefined;

/** The discovery already running for one key, so two callers do not both connect. */
let inFlight: { readonly key: string; readonly promise: Promise<void> } | undefined = undefined;

/**
 * Bumped by `forgetRemoteMcp` and by an account or place change, so a discovery
 * that outlived either cannot publish over the state that now holds. A change
 * to one server's config does not bump it: that server's attempt is what
 * `discover` refuses instead.
 */
let generation = 0;

/** The account and place a caller belongs to, which is what a whole reset answers. */
function scopeOf(place: ChatPlace): string {
  return `${place.chatScope}\u0000${String(currentAuthEpoch())}`;
}

/** Which pass a caller joins: the account/place and every server's config. A token is never part of it. */
function keyFor(place: ChatPlace): string {
  const configs = listRemoteMcpServers().map(server => `${server.id}\u001F${configOf(server)}`);
  return `${scopeOf(place)}\u0000${configs.join('\u001E')}`;
}

/** The deps one discovery runs with. */
function depsFor(
  server: StoredRemoteMcpServer,
  timeoutMs: number,
  attempt: DiscoveryAttempt
): RemoteMcpClientDeps {
  return {
    fetch,
    discoverTimeoutMs: timeoutMs,
    onCallFailure: lostConnection(server, attempt),
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
 * to reach the server again. A sign-out, or an edit to the server while the
 * call was out, wins: its failure is not published under the config that now
 * holds, which is a different endpoint.
 */
function lostConnection(
  server: StoredRemoteMcpServer,
  attempt: DiscoveryAttempt
): (error: RemoteMcpError) => void {
  return error => {
    if (attempt.generation !== generation || observedConfigs.get(server.id) !== attempt.config) {
      return;
    }
    discovered.set(server.id, failureOf(server, error));
    publish();
  };
}

/** One server's discovery, recorded where a screen and a session can read it. */
async function discover(
  server: StoredRemoteMcpServer,
  timeoutMs: number,
  attempt: DiscoveryAttempt
): Promise<void> {
  const outcome = await Effect.runPromise(
    remoteMcpTools(serverValue(server), depsFor(server, timeoutMs, attempt)).pipe(
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
     superseded this discovery: the row belongs to another attempt, so what this
     one answered must not be published, and it must not be cleared either. */
  if (attempts.get(server.id) !== attempt) {
    return;
  }
  attempts.delete(server.id);
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
    attempts.has(state.id) && state.status === 'idle' ? connectingOf(state) : state
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

/**
 * Drops what a store change made stale: the cache names each server whose config
 * moved on, and only those answers are dropped here, so a change to one server
 * costs the others nothing.
 */
function dropStaleAnswers(): void {
  for (const id of reconcile(listRemoteMcpServers())) {
    discovered.delete(id);
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
 * The pass an ask gets: the one already running for this key, or a new one.
 *
 * An automatic ask is answered by the pass it joins. A person's Retry is about a
 * row that has already failed, so it waits for that pass and then asks again —
 * and the recursive call checks admission again in the turn that follows it, so
 * two retries that waited on one pass cannot both start a discovery for the same
 * server. A server another pass is discovering is not missing: its attempt is
 * registered before the first await, so a pass for a superseded key finds
 * nothing to open. The scope is checked again after the wait, because an account
 * or place change clears every attempt and only a caller of that scope may open
 * a connection.
 */
async function ensurePass(
  scope: string,
  key: string,
  request: RemoteMcpRequest
): Promise<readonly RemoteMcpServerState[]> {
  if (inFlight?.key === key) {
    await inFlight.promise;
    if (scope !== scopeKey) {
      return snapshot;
    }
    return request.retry === true ? ensurePass(scope, key, request) : snapshot;
  }
  const missing = listRemoteMcpServers()
    .filter(server => server.enabled)
    .filter(server => !reusable(discovered.get(server.id)))
    .filter(server => !attempts.has(server.id));
  if (missing.length === 0) {
    return snapshot;
  }
  if (request.retry !== true && connectionRefusesWrites()) {
    return failOffline(missing);
  }
  const started = generation;
  const planned = missing.map(server => {
    const attempt = { generation: started, config: configOf(server) };
    discovered.delete(server.id);
    attempts.set(server.id, attempt);
    return { server, attempt };
  });
  publish();
  const discoveries = planned.map(({ server, attempt }) =>
    discover(server, deadlineFor(request), attempt)
  );
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

/**
 * Discovers the enabled servers' tools, reusing the answers already made for the
 * same config and account.
 *
 * A discovery that failed is not an answer: asking again reconnects, which is
 * what a Retry and the next chat both are. Neither is an answer with no tools in
 * it, because the next ask is what makes a transient empty catalog recoverable.
 * One discovery pass runs per key at a time: an automatic ask made while one is
 * running joins it rather than opening a second connection, while a person's
 * Retry waits for it to settle and then asks again for whatever is still
 * missing, so a running pass can never answer a Retry with its own deadline's
 * failure.
 *
 * A change to one server's config costs the other servers nothing: their
 * answers, views and running discoveries are the ones their own config earned.
 * Only a change of account or place drops everything.
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
  const scope = scopeOf(place);
  if (scope !== scopeKey) {
    /* The account or the place changed, so no discovery or answer belongs to
       this one: bumping the generation stops every discovery that outlived it
       from publishing, and the cache starts empty for the new caller. */
    generation += 1;
    scopeKey = scope;
    forgetCache();
    discovered = new Map();
    forgetCallResults();
    inFlight = undefined;
    publish();
  }
  dropStaleAnswers();
  return ensurePass(scope, keyFor(place), request);
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
  const deps = depsFor(server, AUTOMATIC_TIMEOUT_MS, {
    generation,
    config: configOf(server),
  });
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
  scopeKey = undefined;
  forgetCache();
  discovered = new Map();
  forgetCallResults();
  inFlight = undefined;
  publish();
}

// The list is the app's own, so a change to it — an add, an edit, a delete, an
// enable or a disable — is what makes the discovered state stale. A server that
// moved on loses its answer here, and every other server keeps its own.
subscribeRemoteMcpServers(() => {
  dropStaleAnswers();
  publish();
});
publish();
