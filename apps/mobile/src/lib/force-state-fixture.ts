/**
 * Dev-only forced data state. One link puts every data screen into one state,
 * so the design gate can capture each screen's loading, error and offline
 * states without a fixture per screen:
 *
 * - `kiloapp:///dev/force-state/<mode>?next=<url-encoded app link>` forces the
 *   mode, then opens `next` the way the app opens that link on its own
 *   (`next` is optional; without it the current screen stays and reloads).
 * - `kiloapp:///dev/force-state/clear` returns live answers and opens Home
 *   (or `?next=`).
 *
 * Modes, each the answer a real backend or device gives:
 *
 * - `loading`: requests stay in flight until the mode changes.
 * - `retryable`: `INTERNAL_SERVER_ERROR` (500), the `server` variant with
 *   Retry. The query client still makes its own two retries first (about 3 s).
 * - `non-retryable`: `NOT_FOUND` (404), a terminal code: the `not-found`
 *   variant, and screens that read the code offer no Retry.
 * - `permission`: `FORBIDDEN` (403), the `permission` variant. It is not the
 *   context-level `authRequired` refusal, so it never signs the user out.
 * - `offline`: every connectivity subscription reports no network and the
 *   backend probe fails, so `onlineManager` pauses queries at once and the
 *   offline banner commits after its usual 5 s confirmation. A request that
 *   still runs fails the way React Native's fetch does without a network.
 *
 * The mode applies to tRPC requests only, mutations included, so a forced
 * session never writes to the backend. The auth and session bootstrap
 * procedures ({@link BOOTSTRAP_PROCEDURES}) keep their live answers, so the
 * account, the organization context and the session plumbing stay intact.
 * Forcing a mode resets the cached tRPC queries (except the bootstrap ones), so
 * each screen shows its first-load state instead of cached rows.
 *
 * From the first forced mode until the app restarts, the encrypted read cache
 * takes no writes: the reset queries and forced failures never reach it, and
 * the snapshot from before the first mode is what the next launch restores.
 *
 * The only entry point is `+native-intent.tsx`, behind `__DEV__`; every other
 * reader checks `__DEV__` first, so a release build never reaches this module.
 */
import { type Query, type QueryClient } from '@tanstack/react-query';

import { type ConnectivityState } from '@/lib/connectivity-online';
import { requestUrlString, trpcProcedureText } from '@/lib/telemetry/request-target';

const FORCE_STATE_MODES = [
  'loading',
  'retryable',
  'non-retryable',
  'permission',
  'offline',
] as const;

export type ForceStateMode = (typeof FORCE_STATE_MODES)[number];

type ForceState =
  // No mode was forced since the app started.
  | { readonly kind: 'live' }
  | { readonly kind: 'forced'; readonly mode: ForceStateMode }
  // Live answers again; the read cache stays held until the app restarts.
  | { readonly kind: 'cleared' };

/**
 * Procedures that keep their live answers in every mode: the account
 * (`user.getMe` confirms the session; a refusal there is a sign-out), the
 * organization context, and the device-session and push-token calls that
 * sign-in and sign-out make.
 */
const BOOTSTRAP_PROCEDURES: ReadonlySet<string> = new Set([
  'user.getMe',
  'organizations.list',
  'user.registerPushToken',
  'user.unregisterPushToken',
  'user.registerActivityToken',
  'user.unregisterActivityToken',
  'user.revokeCurrentDeviceSession',
]);

type ForcedError = {
  code: string;
  jsonRpcCode: number;
  httpStatus: number;
  message: string;
};

/** The server's error answer for each failing mode (tRPC's code table). */
const FORCED_ERRORS = {
  retryable: {
    code: 'INTERNAL_SERVER_ERROR',
    jsonRpcCode: -32603,
    httpStatus: 500,
    message: 'Internal server error',
  },
  'non-retryable': {
    code: 'NOT_FOUND',
    jsonRpcCode: -32004,
    httpStatus: 404,
    message: 'Not found',
  },
  permission: { code: 'FORBIDDEN', jsonRpcCode: -32003, httpStatus: 403, message: 'Forbidden' },
} satisfies Record<Exclude<ForceStateMode, 'loading' | 'offline'>, ForcedError>;

/** What NetInfo reports with no network at all. */
const FORCED_OFFLINE: ConnectivityState = { isConnected: false, isInternetReachable: false };

const FORCE_STATE_PATH = /(?:^|\/)dev\/force-state\/([a-z-]+)\/?(?:\?([^#]*))?(?:#.*)?$/;
const CLEAR = 'clear';
const HOME_LINK = '/(app)/(tabs)/(0_home)';

let state: ForceState = { kind: 'live' };
const listeners = new Set<() => void>();

function log(message: string): void {
  // eslint-disable-next-line no-console -- dev-only harness feedback in the Metro log
  console.info(`[force-state] ${message}`);
}

function setState(next: ForceState): void {
  state = next;
  for (const listener of listeners) {
    listener();
  }
}

function subscribeForceState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getForcedMode(): ForceStateMode | null {
  return state.kind === 'forced' ? state.mode : null;
}

/** True when a forced mode answers this procedure instead of the backend. */
export function isForcedProcedure(path: string): boolean {
  return state.kind === 'forced' && !BOOTSTRAP_PROCEDURES.has(path);
}

/** True from the first forced mode until the app restarts. */
export function isForceStateHoldingReadCache(): boolean {
  return state.kind !== 'live';
}

/** True while the `offline` mode holds, for the backend reachability probe. */
export function isForcedOffline(): boolean {
  return getForcedMode() === 'offline';
}

/** Settles on the next mode change, or rejects as fetch does when `signal` aborts. */
function nextModeChange(signal: AbortSignal | null | undefined): Promise<undefined> {
  const { promise, resolve, reject } = Promise.withResolvers<undefined>();
  const onAbort = () => {
    unsubscribe();
    reject(signal?.reason);
  };
  const unsubscribe = subscribeForceState(() => {
    unsubscribe();
    signal?.removeEventListener('abort', onAbort);
    resolve(undefined);
  });
  if (signal?.aborted) {
    onAbort();
  } else {
    signal?.addEventListener('abort', onAbort);
  }
  return promise;
}

/** The body a tRPC server sends for a failed single (unbatched) call. */
function errorResponse(error: ForcedError, path: string): Response {
  const body = {
    error: {
      message: error.message,
      code: error.jsonRpcCode,
      data: { code: error.code, httpStatus: error.httpStatus, path, zodError: null },
    },
  };
  // eslint-disable-next-line unicorn/prefer-response-static-json -- React Native's fetch polyfill has no static Response.json.
  return new Response(JSON.stringify(body), {
    status: error.httpStatus,
    headers: { 'content-type': 'application/json' },
  });
}

async function forcedFetch(
  path: string,
  send: () => Promise<Response>,
  signal: AbortSignal | null | undefined
): Promise<Response> {
  const mode = isForcedProcedure(path) ? getForcedMode() : null;
  if (mode === null) {
    return send();
  }
  if (mode === 'loading') {
    await nextModeChange(signal);
    return forcedFetch(path, send, signal);
  }
  if (mode === 'offline') {
    throw new TypeError('Network request failed');
  }
  return errorResponse(FORCED_ERRORS[mode], path);
}

/**
 * The fetch of the unbatched tRPC link, answering a forced procedure in the
 * mode. The tRPC link routes every forced procedure here (a batch would mix
 * forced and live calls); a batched URL reaches the backend unchanged.
 */
export function withForceState(fetchImpl: typeof fetch): typeof fetch {
  return (input, init) => {
    const procedure = trpcProcedureText(requestUrlString(input));
    if (procedure === undefined || procedure.includes(',')) {
      return fetchImpl(input, init);
    }
    return forcedFetch(procedure, () => fetchImpl(input, init), init?.signal);
  };
}

/**
 * A connectivity subscription that reports no network while `offline` holds,
 * and the latest live report again when it ends.
 */
export function subscribeConnectivityWithForceState(
  subscribe: (listener: (connectivity: ConnectivityState) => void) => () => void,
  listener: (connectivity: ConnectivityState) => void
): () => void {
  let live: ConnectivityState | null = null;
  let forcedOffline = isForcedOffline();
  const unsubscribeLive = subscribe(connectivity => {
    live = connectivity;
    if (!forcedOffline) {
      listener(connectivity);
    }
  });
  const unsubscribeMode = subscribeForceState(() => {
    const offline = isForcedOffline();
    if (offline === forcedOffline) {
      return;
    }
    forcedOffline = offline;
    if (offline) {
      listener(FORCED_OFFLINE);
    } else if (live !== null) {
      listener(live);
    }
  });
  if (forcedOffline) {
    listener(FORCED_OFFLINE);
  }
  return () => {
    unsubscribeMode();
    unsubscribeLive();
  };
}

/** The dotted procedure of a tRPC query key, or null for an app key. */
function trpcQueryPath(queryKey: readonly unknown[]): string | null {
  const segments = queryKey[0];
  if (!Array.isArray(segments) || segments.length === 0) {
    return null;
  }
  return segments.join('.');
}

function isResettableQuery(query: Query): boolean {
  const path = trpcQueryPath(query.queryKey);
  return path !== null && !BOOTSTRAP_PROCEDURES.has(path);
}

/**
 * Applies a force-state link. Undefined when the path is not one; otherwise
 * the app link to open next, or null to stay on the current screen.
 */
export function applyForceStatePath(path: string, client: QueryClient): string | null | undefined {
  const match = FORCE_STATE_PATH.exec(path);
  if (!match) {
    return undefined;
  }
  const name = match[1];
  const next = new URLSearchParams(match[2] ?? '').get('next');
  if (name === CLEAR) {
    if (state.kind === 'forced') {
      setState({ kind: 'cleared' });
      void client.resetQueries({ predicate: isResettableQuery });
      log('cleared; read cache writes stay held until the app restarts');
    }
    return next ?? HOME_LINK;
  }
  const mode = FORCE_STATE_MODES.find(candidate => candidate === name);
  if (mode === undefined) {
    log(`unknown mode ${name}`);
    return null;
  }
  setState({ kind: 'forced', mode });
  void client.resetQueries({ predicate: isResettableQuery });
  log(`forced ${mode}`);
  return next;
}

/** Test-only: return to the state of a fresh app start. */
export function resetForceStateForTests(): void {
  setState({ kind: 'live' });
}
