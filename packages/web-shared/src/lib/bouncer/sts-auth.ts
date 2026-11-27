import 'server-only';
import {
  BouncerStsConfigError,
  type BouncerScope,
  type BouncerTransport,
} from '@kilocode/web-shared/lib/bouncer/sts-auth-contract';
import { waitUntil } from '@vercel/functions';

/**
 * The STS service tokens the shared Bouncer client sends (Bouncer STS integration design 3.1).
 *
 * `apps/web` and `apps/ai-gateway` install one `BouncerAuth` from `instrumentation.ts`, each with
 * the Bouncer scopes its STS policy grants. Every call then names its caller in `x-kilo-caller`.
 * With `BOUNCER_STS_TOKENS=on` the call also carries `Authorization: Bearer <STS token>` for the
 * route's scope, next to the unchanged `x-internal-api-key`: Bouncer's `legacy` mode ignores the
 * bearer and its `dual` mode verifies it. Scripts and tests install nothing, so they send neither.
 *
 * Tokens: the token client keeps each token in memory; a read after 80 % of a token's lifetime
 * starts its renewal in the background. Every call reads all of the app's granted scopes (the
 * route's own, plus the others in the background), so a rarely used scope is renewed by the
 * traffic of the others and only an instance without any Bouncer call for most of a token's
 * lifetime has to mint again.
 *
 * Budgets: a call whose route waits (decide, charge-decide, signup-decide) waits at most
 * `BOUNCER_TOKEN_WAIT_MS` for a token it does not hold, out of the call's own deadline, and only
 * when the deployment's exchanged Vercel token is already held, so the mint is one STS call. A
 * deployment's first calls, before that exchange, wait 0 (`exchange_pending`). Every other route
 * never waits. A call without a token proceeds with the legacy key alone. Each mint that does not
 * answer within a wait counts once toward the breaker; after `BOUNCER_BREAKER_THRESHOLD` such
 * mints in a row the wait drops to 0 until a read that waited for a mint gets its token. After
 * Bouncer answers 401 to a call that carried a scope's token, that scope's token is held back for
 * `BOUNCER_REJECTED_HOLD_MS`.
 *
 * This module stays light: the token client, the Vercel OIDC exchange and the Runtime Cache load
 * on the first call with the flag on (`sts-token-transport.ts`).
 */

/**
 * The `x-kilo-caller` values: the labels Bouncer's legacy-call counters accept (`KNOWN_CALLERS` in
 * Kilo-Org/bouncer `src/api-auth.ts`). They are counting labels, not STS workload names: Bouncer
 * attributes a call that carries a token by the token's `sub` (`service:web`, `service:ai-gateway`).
 */
export type BouncerCaller = 'kilocode-app' | 'kilocode-ai-gateway';

/** The headers one Bouncer call adds besides `content-type` and `x-internal-api-key`. */
export type BouncerAuthHeaders = Readonly<Record<string, string>>;

/**
 * One call: its scope, whether its route waits for a token it does not hold, and the call's
 * deadline, which also ends the wait.
 */
export type BouncerAuthCall = { scope: BouncerScope; wait: boolean; signal?: AbortSignal };

export type BouncerAuth = {
  headers(call: BouncerAuthCall): Promise<BouncerAuthHeaders>;
  /** Bouncer answered 401 to a call that carried this scope's token. */
  rejected(scope: BouncerScope): void;
};

/** Design 3.1: a caller reads its token within 250 ms of its own. */
export const BOUNCER_TOKEN_WAIT_MS = 250;
/** Design 3.1: mints in a row that did not answer within a wait before the breaker opens. */
export const BOUNCER_BREAKER_THRESHOLD = 10;
/** How long a scope's token is held back after Bouncer refused it. */
export const BOUNCER_REJECTED_HOLD_MS = 60_000;
/**
 * One `bouncer_sts_tokens` line per instance per this interval, with every count since the
 * previous line. It is written by the first call after the interval ends, so an idle instance
 * writes nothing.
 */
export const BOUNCER_COUNT_LOG_INTERVAL_MS = 60_000;

/**
 * Why a call went without a token.
 * - `timeout`: a wait ran out while a mint was running.
 * - `breaker_open`: the breaker skipped the wait.
 * - `exchange_pending`: the deployment's exchanged Vercel token is not held yet, so no wait.
 * - `not_held`: the route never waits and no fresh token was held.
 * - `aborted`: the call's own deadline or its caller ended the wait.
 * - `rejected`: Bouncer refused this scope's token within the hold.
 * - `denied`, `unavailable`: the token client's answer.
 * - `load`: the transport did not load.
 * - `config`: the flag, the deployment's STS settings, or a scope the app is not granted.
 */
export type BouncerTokenMissReason =
  | 'timeout'
  | 'breaker_open'
  | 'exchange_pending'
  | 'not_held'
  | 'aborted'
  | 'rejected'
  | 'denied'
  | 'unavailable'
  | 'load'
  | 'config';

/**
 * `BOUNCER_STS_TOKENS`: `on` sends STS tokens; unset, empty or `off` sends the legacy key alone.
 * Any other value also sends the legacy key alone and counts as a `config` miss, so a typo can
 * never stop Bouncer calls.
 */
export function bouncerStsTokensEnabled(value: string | undefined): boolean | 'invalid' {
  if (value === undefined || value === '' || value === 'off') return false;
  if (value === 'on') return true;
  return 'invalid';
}

type Raced<T> = { value: T } | { error: unknown } | 'waited' | 'aborted';

/**
 * `promise`, or `waited` once `ms` passes, or `aborted` once `signal` aborts, whichever is first. A
 * value already settled wins a 0 ms race.
 */
async function race<T>(promise: Promise<T>, ms: number, signal?: AbortSignal): Promise<Raced<T>> {
  const timer = Promise.withResolvers<'waited' | 'aborted'>();
  const abort = () => timer.resolve('aborted');
  const handle = setTimeout(() => timer.resolve('waited'), Math.max(0, ms));
  if (signal?.aborted) abort();
  signal?.addEventListener('abort', abort, { once: true });
  try {
    return await Promise.race([
      promise.then(
        value => ({ value }),
        (error: unknown) => ({ error })
      ),
      timer.promise,
    ]);
  } finally {
    clearTimeout(handle);
    signal?.removeEventListener('abort', abort);
  }
}

/** A transport module that did not load; nothing of the cause is logged. */
class BouncerTransportLoadError extends Error {
  constructor(cause: unknown) {
    super('The Bouncer STS token transport did not load', { cause });
    this.name = 'BouncerTransportLoadError';
  }
}

function missReasonOf(error: unknown): BouncerTokenMissReason {
  if (error instanceof BouncerTransportLoadError) return 'load';
  if (error instanceof BouncerStsConfigError) return 'config';
  // `ServiceTokenError` by value, so this module never imports the token client.
  const { name, reason } = (error ?? {}) as { name?: unknown; reason?: unknown };
  return name === 'ServiceTokenError' && reason === 'denied' ? 'denied' : 'unavailable';
}

export type BouncerAuthOptions = {
  caller: BouncerCaller;
  /** The Bouncer scopes the app's STS policy grants; no other scope is ever read. */
  scopes: readonly BouncerScope[];
  /** The flag's current value; read on every call. */
  flag: () => string | undefined;
  /** Loads the transport once; a rejection marks a `load` (or `config`) miss and is retried. */
  loadTransport: () => Promise<BouncerTransport>;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
  log?: (line: string, level: 'info' | 'warn') => void;
};

export function createBouncerAuth(options: BouncerAuthOptions): BouncerAuth {
  const now = options.now ?? Date.now;
  const log =
    options.log ?? ((line, level) => (level === 'warn' ? console.warn(line) : console.info(line)));
  const callerHeaders: BouncerAuthHeaders = { 'x-kilo-caller': options.caller };
  const ctx = { waitUntil: options.waitUntil };
  let loading: Promise<BouncerTransport> | null = null;
  /** Mints in a row that did not answer within a wait. */
  let timeouts = 0;
  /** The read whose running mint already counted toward the breaker. */
  let countedMint: Promise<string> | null = null;
  /** The read handed to `waitUntil` to keep the running mint alive past the response. */
  let heldMint: Promise<string> | null = null;
  const rejectedUntil = new Map<BouncerScope, number>();
  let attached: Record<string, number> = {};
  let missed: Record<string, Record<string, number>> = {};
  let flushedAt: number | null = null;

  function load(): Promise<BouncerTransport> {
    loading ??= options.loadTransport().catch((error: unknown) => {
      loading = null;
      throw error instanceof BouncerStsConfigError ? error : new BouncerTransportLoadError(error);
    });
    return loading;
  }

  /** Writes the counts when the interval has ended; the first count of the instance writes too. */
  function flushIfDue(): void {
    const at = now();
    if (flushedAt !== null && at - flushedAt < BOUNCER_COUNT_LOG_INTERVAL_MS) return;
    log(
      JSON.stringify({ event: 'bouncer_sts_tokens', caller: options.caller, attached, missed }),
      'info'
    );
    attached = {};
    missed = {};
    flushedAt = at;
  }

  function attach(scope: BouncerScope, token: string): BouncerAuthHeaders {
    attached[scope] = (attached[scope] ?? 0) + 1;
    flushIfDue();
    return { ...callerHeaders, authorization: `Bearer ${token}` };
  }

  function miss(reason: BouncerTokenMissReason, scope: BouncerScope): BouncerAuthHeaders {
    const byReason = (missed[scope] ??= {});
    byReason[reason] = (byReason[reason] ?? 0) + 1;
    flushIfDue();
    return callerHeaders;
  }

  /** Keeps a running mint alive past the response: one read per mint, not one per waiting call. */
  function holdMint(reading: Promise<string>): void {
    if (heldMint !== null) return;
    heldMint = reading;
    const release = () => {
      if (heldMint === reading) heldMint = null;
    };
    options.waitUntil(reading.then(release, release));
  }

  /** Counts a wait that ran out toward the breaker, once per running mint. */
  function timedOut(reading: Promise<string>): void {
    if (countedMint !== null) return;
    countedMint = reading;
    const release = () => {
      if (countedMint === reading) countedMint = null;
    };
    void reading.then(release, release);
    timeouts += 1;
    if (timeouts === BOUNCER_BREAKER_THRESHOLD) {
      log(JSON.stringify({ event: 'bouncer_sts_breaker_open', caller: options.caller }), 'warn');
    }
  }

  /** A read that waited for a mint got its token: the mint path works again. */
  function mintSucceeded(): void {
    if (timeouts >= BOUNCER_BREAKER_THRESHOLD) {
      log(JSON.stringify({ event: 'bouncer_sts_breaker_closed', caller: options.caller }), 'warn');
    }
    timeouts = 0;
  }

  /** Reads the app's other granted scopes in the background, so their renewals start too. */
  function warmSiblings(transport: Promise<BouncerTransport>, scope: BouncerScope): void {
    for (const other of options.scopes) {
      if (other === scope) continue;
      const reading = transport.then(t => t.read({ audience: 'bouncer', scope: other }, ctx));
      options.waitUntil(reading.catch(() => undefined));
    }
  }

  return {
    rejected(scope) {
      if (!options.scopes.includes(scope)) return;
      const held = (rejectedUntil.get(scope) ?? 0) > now();
      rejectedUntil.set(scope, now() + BOUNCER_REJECTED_HOLD_MS);
      if (!held) {
        log(
          JSON.stringify({ event: 'bouncer_sts_token_rejected', caller: options.caller, scope }),
          'warn'
        );
      }
    },

    async headers({ scope, wait, signal }) {
      const enabled = bouncerStsTokensEnabled(options.flag());
      if (enabled === 'invalid') return miss('config', scope);
      if (enabled !== true) return callerHeaders;
      if (!options.scopes.includes(scope)) return miss('config', scope);
      // The whole wait, the held check and the readiness check included, counts from here.
      const started = now();
      const transport = load();
      // Settled by the read below or by `warmSiblings`; the rejection reaches the caller there.
      void transport.catch(() => undefined);
      const reading = transport.then(t => t.read({ audience: 'bouncer', scope }, ctx));
      warmSiblings(transport, scope);
      if ((rejectedUntil.get(scope) ?? 0) > now()) {
        void reading.catch(() => undefined);
        return miss('rejected', scope);
      }

      const held = await race(reading, 0, signal);
      if (held === 'aborted') return miss('aborted', scope);
      if (held !== 'waited') {
        return 'value' in held ? attach(scope, held.value) : miss(missReasonOf(held.error), scope);
      }

      // No fresh token: a mint is running. Keep it alive, and let its success close the breaker.
      holdMint(reading);
      void reading.then(mintSucceeded, () => undefined);
      if (!wait) return miss('not_held', scope);
      if (timeouts >= BOUNCER_BREAKER_THRESHOLD) return miss('breaker_open', scope);

      const ready = await race(
        transport.then(t => t.exchangeReady()),
        BOUNCER_TOKEN_WAIT_MS - (now() - started),
        signal
      );
      if (ready === 'aborted') return miss('aborted', scope);
      if (ready === 'waited' || !('value' in ready) || !ready.value) {
        return miss('exchange_pending', scope);
      }

      const minted = await race(reading, BOUNCER_TOKEN_WAIT_MS - (now() - started), signal);
      if (minted === 'aborted') return miss('aborted', scope);
      if (minted === 'waited') {
        timedOut(reading);
        return miss('timeout', scope);
      }
      return 'value' in minted
        ? attach(scope, minted.value)
        : miss(missReasonOf(minted.error), scope);
    },
  };
}

declare global {
  // Next.js evaluates a module once per bundle layer, so the auth an app installs from
  // `instrumentation.ts` reaches its route handlers only through a process-wide slot.
  var __kilocodeBouncerAuth: BouncerAuth | undefined;
}

/**
 * Installs the auth for `caller` and the Bouncer scopes its STS policy grants; called once from
 * the `instrumentation.ts` of `apps/web` and `apps/ai-gateway`. Installing builds and loads
 * nothing: the flag is read on every call, and the transport loads on the first call with it on.
 */
export function installBouncerAuth(caller: BouncerCaller, scopes: readonly BouncerScope[]): void {
  globalThis.__kilocodeBouncerAuth = createBouncerAuth({
    caller,
    scopes,
    flag: () => process.env.BOUNCER_STS_TOKENS,
    loadTransport: async () => {
      // Lazy on purpose, as `sts-secret-reader.ts` does: a deployment with the flag off never loads
      // the token client, the Vercel OIDC exchange or the Runtime Cache.
      const { createBouncerTransport } =
        await import('@kilocode/web-shared/lib/bouncer/sts-token-transport');
      return createBouncerTransport();
    },
    waitUntil,
  });
}

/** The installed auth's headers for one call; none in a process that installed nothing. */
export async function bouncerAuthHeaders(call: BouncerAuthCall): Promise<BouncerAuthHeaders> {
  const auth = globalThis.__kilocodeBouncerAuth;
  return auth === undefined ? {} : auth.headers(call);
}

/** Reports Bouncer's 401 to a call that carried this scope's token; a no-op without an auth. */
export function bouncerAuthRejected(scope: BouncerScope): void {
  globalThis.__kilocodeBouncerAuth?.rejected(scope);
}
