import { Effect } from 'effect';
import { type Tool } from '@kilocode/harness-sdk';
import {
  RemoteMcpError,
  type RemoteMcpFailure,
  type RemoteMcpServer,
  remoteMcpTools,
} from '@kilocode/harness-sdk/plugins/remote-mcp';

import { currentAuthEpoch } from '@/lib/auth/auth-epoch';
import { getAuthTokenForRequest } from '@/lib/auth/token-owner';
import { KILO_MCP_URL } from '@/lib/config';
import { getItem, removeItem, setItem } from '@/lib/persist/encrypted-kv';
import { type ChatPlace } from './scope';

/**
 * The Kilo MCP server, derived from the session the app already has.
 *
 * There is no key to paste and no URL to type: the build carries the server's
 * URL, the person is signed in, and the credential is the same bearer token
 * every other request uses. This module is the only place that knows all three,
 * so signing out can drop the whole connection from one call.
 *
 * The token is never held here. It is read fresh for each discovery, so a
 * rotated one is used rather than the one the process started with, and a
 * discovery is cached against the chat scope and the auth epoch — never
 * against the token — so an account or token that changed since the cache was
 * written can never be served from it.
 */

/** What the connection looks like to whoever draws it. */
export type KiloMcpState =
  | { readonly status: 'idle' }
  | { readonly status: 'connecting' }
  | { readonly status: 'ready'; readonly tools: readonly Tool[] }
  | { readonly status: 'failed'; readonly kind: RemoteMcpFailure; readonly retryable: boolean };

/** The id the server's tools are named under: `mcp_kilo_<tool>`. */
const SERVER_ID = 'kilo';

/**
 * How long a *discovery* may take, chosen by the caller. A chat opening bounds
 * it at four seconds, because that happens while the chat is opening and a
 * server that has not answered by then is one the chat should not wait for. A
 * Retry gets fifteen: a person asked for it, so they are willing to wait, and
 * the failure is the thing being given another chance.
 *
 * It bounds the discovery and nothing else. A tool call keeps the harness's own
 * bound — sixty seconds, above the tool's fifteen-second `inlineFor` — so a
 * slow call answers, or is backgrounded by the session and still answers,
 * instead of failing at the chat-open deadline.
 */
const AUTOMATIC_TIMEOUT_MS = 4000;
const RETRY_TIMEOUT_MS = 15_000;

/** Where the per-chat preference lives, and what "off" is written as. */
const PREFERENCE_SCOPE = 'chat-mcp';
const OFF = 'off';

/**
 * The one server this app knows, at the URL the build carries.
 *
 * `bearer` rather than a pasted key: the credential is the signed-in session's
 * own token, and the server accepts it because it is the same account.
 */
function kiloServer(url: string): RemoteMcpServer {
  return {
    id: SERVER_ID,
    name: 'Kilo tools',
    url: `${url}/mcp`,
    auth: { type: 'bearer' },
  };
}

/**
 * The credential for one discovery, asked each time so a rotated token is used
 * instead of the one the process started with. A signed-out app has none, which
 * is reported as the server refusing the credential rather than as an
 * anonymous request.
 */
const kiloToken = (): Effect.Effect<string, RemoteMcpError> =>
  Effect.tryPromise({
    try: async () => {
      const token = await getAuthTokenForRequest();
      if (token === null) {
        throw new Error('the app is signed out');
      }
      return token;
    },
    catch: cause => new RemoteMcpError({ serverId: SERVER_ID, kind: 'unauthorized', cause }),
  });

const ready = (tools: readonly Tool[]): KiloMcpState => ({ status: 'ready', tools });

/**
 * A Retry can fix a server that is down, a refused credential or a protocol
 * the server got wrong. It cannot fix a server that is not there any more, so
 * `missing` is the one failure the screen must not offer a Retry for.
 */
const failed = (error: RemoteMcpError): KiloMcpState => ({
  status: 'failed',
  kind: error.kind,
  retryable: error.kind !== 'missing',
});

/** The snapshot React draws. Replaced whole, so a watcher can compare it by reference. */
let snapshot: KiloMcpState = { status: 'idle' };
const listeners = new Set<() => void>();

function publish(state: KiloMcpState): void {
  snapshot = state;
  for (const listener of listeners) {
    listener();
  }
}

/** The answer already discovered for one account and one auth epoch. */
let cached: { readonly key: string; readonly state: KiloMcpState } | undefined = undefined;

/** The discovery already running for one key, so two callers do not both connect. */
let inFlight:
  | { readonly id: number; readonly key: string; readonly promise: Promise<KiloMcpState> }
  | undefined = undefined;

let nextAttempt = 0;

/** Bumped by `forgetKiloMcp`, so a discovery that outlived it cannot publish. */
let generation = 0;

/** Which account and auth epoch an answer belongs to. */
const keyFor = (place: ChatPlace): string =>
  `${place.chatScope}\u0000${String(currentAuthEpoch())}`;

/**
 * A call that did not reach the server, published as the failure the screen
 * draws: the dot turns red, the sheet says what happened, and a Retry is
 * offered. Without it the dot stays green and the sheet keeps counting tools
 * while every call fails, because a failed tool result goes to the model and
 * never to a screen.
 *
 * The answer that just stopped being true is dropped here rather than only
 * covered up. A discovery is served from `cached` when it is `ready`, and the
 * whole point of the Retry is to reach the server again — leaving the cached
 * list in place would answer the Retry with the tools that had just failed
 * every call.
 *
 * A sign-out between the discovery and the failure wins: the old account's
 * failure is not published under the new one, exactly as its tools are not.
 */
const lostConnection =
  (started: number) =>
  (error: RemoteMcpError): void => {
    if (started !== generation) {
      return;
    }
    cached = undefined;
    publish(failed(error));
  };

/**
 * Whether a later caller may be served this answer again.
 *
 * A server that named tools keeps them for the account and the epoch, so the
 * next chat does not open a second connection for the same list. A server that
 * answered with none is the one answer that must be asked again: the empty
 * sheet offers no Retry, so a catalog that was mid-deploy when the first chat
 * asked would leave every chat after it on "No tools available" until the app
 * was restarted. The next ask reconnects and says what the server offers now.
 */
const reusable = (state: KiloMcpState): boolean =>
  state.status !== 'ready' || state.tools.length > 0;

/**
 * One discovery. A defect — the plugin throwing rather than failing — is
 * reported as a server that could not be reached, because a rejected promise
 * here would leave a chat opening with no state to draw.
 */
async function connect(place: ChatPlace, timeoutMs: number): Promise<KiloMcpState> {
  const started = generation;
  const key = keyFor(place);
  const url = KILO_MCP_URL;
  if (url === undefined) {
    return { status: 'idle' };
  }
  const state = await Effect.runPromise(
    remoteMcpTools(kiloServer(url), {
      fetch,
      token: kiloToken,
      discoverTimeoutMs: timeoutMs,
      onCallFailure: lostConnection(started),
    }).pipe(
      Effect.match({ onFailure: failed, onSuccess: ready }),
      Effect.catchAllCause(cause =>
        Effect.succeed(
          failed(new RemoteMcpError({ serverId: SERVER_ID, kind: 'unreachable', cause }))
        )
      )
    )
  );
  /* A sign-out between the request and the answer dropped the connection. What
     the old account's server answered must not be published under the new one. */
  if (started === generation) {
    cached = reusable(state) ? { key, state } : undefined;
    publish(state);
  }
  return state;
}

async function attempt(place: ChatPlace, timeoutMs: number): Promise<KiloMcpState> {
  const key = keyFor(place);
  if (cached?.key === key && cached.state.status === 'ready') {
    /* The registry reads the snapshot, not this return value. Another scope's
       discovery may have published over it since, so the answer served is
       published too. */
    if (snapshot !== cached.state) {
      publish(cached.state);
    }
    return cached.state;
  }
  if (inFlight?.key === key) {
    return inFlight.promise;
  }
  /* No URL means the feature is not built into this app at all. Nothing is
     asked of a server, and the screen has nothing to show. */
  if (KILO_MCP_URL === undefined) {
    publish({ status: 'idle' });
    return { status: 'idle' };
  }
  publish({ status: 'connecting' });
  const id = (nextAttempt += 1);
  const promise = connect(place, timeoutMs);
  const entry = { id, key, promise };
  inFlight = entry;
  try {
    return await promise;
  } finally {
    if (inFlight === entry) {
      inFlight = undefined;
    }
  }
}

/**
 * Who is waiting for a discovery, which is the only thing that sets its
 * deadline. `automatic` is the four-second bound an open gets: a chat must not
 * wait on a server that has not answered by then. `retry` is the fifteen-second
 * bound a person's Retry gets, because they asked for it and the failure is what
 * is being given another chance.
 */
export type KiloMcpRequest = 'automatic' | 'retry';

/** The deadline for one request: the person's Retry waits longer than an open. */
const deadlineFor = (request: KiloMcpRequest): number =>
  request === 'retry' ? RETRY_TIMEOUT_MS : AUTOMATIC_TIMEOUT_MS;

/**
 * Discovers the server's tools for the chat's scope, reusing an answer already
 * made for the same account and epoch.
 *
 * The deadline belongs to the caller, not to the last answer: a chat opening
 * asks for `automatic` and gives the server four seconds, so a slow one leaves
 * the chat usable on the base tools rather than holding the send; a person
 * pressing Retry asks for `retry` and waits longer, because they asked for it.
 * Nothing here reads a previous failure to choose one — that made an open that
 * followed a Retry wait the Retry's fifteen seconds.
 *
 * A failure is not cached as an answer: asking again reconnects. Neither is an
 * answer with no tools in it, because the empty sheet offers no Retry and the
 * next chat asking is what makes a transient empty catalog recoverable. A call
 * made while one is already running joins it rather than opening a second
 * connection.
 */
export async function ensureKiloMcp(
  place: ChatPlace,
  request: KiloMcpRequest = 'automatic'
): Promise<KiloMcpState> {
  const state = await attempt(place, deadlineFor(request));
  return state;
}

/** The snapshot a screen draws, whether or not a discovery is running. */
export function kiloMcpState(): KiloMcpState {
  return snapshot;
}

/** The tools discovered so far, which is what the registry is built from. */
export function kiloMcpTools(): readonly Tool[] {
  return snapshot.status === 'ready' ? snapshot.tools : [];
}

/** The names of those tools, which is what a session is opened with. */
export function kiloMcpToolNames(): readonly string[] {
  return kiloMcpTools().map(tool => tool.definition.name);
}

/** Watches the snapshot, the way a screen subscribes to a chat. */
export function watchKiloMcp(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drops the connection now: no cached tools and no cached identity survive, and
 * a discovery still running cannot publish over the next account.
 */
export function forgetKiloMcp(): void {
  generation += 1;
  cached = undefined;
  inFlight = undefined;
  publish({ status: 'idle' });
}

/**
 * Whether the Kilo server is used in one chat.
 *
 * Absent means on: the server is available automatically to a signed-in
 * account, so only the chats a person turned it off for carry a value. The
 * value is written under the session id, exactly as the unanswered question is.
 */
export async function mcpEnabledFor(sessionId: string): Promise<boolean> {
  return (await getItem(PREFERENCE_SCOPE, sessionId)) !== OFF;
}

export async function setMcpEnabled(sessionId: string, enabled: boolean): Promise<void> {
  if (enabled) {
    await removeItem(PREFERENCE_SCOPE, sessionId);
    return;
  }
  await setItem(PREFERENCE_SCOPE, sessionId, OFF);
}

/** Carries the setting across a model switch, which opens a new session. */
export async function moveMcpEnabled(from: string, to: string): Promise<void> {
  const enabled = await mcpEnabledFor(from);
  await removeItem(PREFERENCE_SCOPE, from);
  if (enabled) {
    await removeItem(PREFERENCE_SCOPE, to);
    return;
  }
  await setItem(PREFERENCE_SCOPE, to, OFF);
}

/** Drops the settings of chats that are gone, which is what signing out does. */
export async function forgetMcpEnabled(sessionIds: readonly string[]): Promise<void> {
  for (const sessionId of sessionIds) {
    // eslint-disable-next-line no-await-in-loop -- one connection and no lock: the deletes go one at a time
    await removeItem(PREFERENCE_SCOPE, sessionId);
  }
}
