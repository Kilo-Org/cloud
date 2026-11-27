import 'server-only';
import {
  BOUNCER_APP_SCOPES,
  BouncerStsConfigError,
  type BouncerCaller,
  type BouncerScope,
  type BouncerTransport,
  type BouncerTransportHooks,
} from '@kilocode/web-shared/lib/bouncer/sts-auth-contract';
import { waitUntil } from '@vercel/functions';

/**
 * The STS service tokens the shared Bouncer client sends (Bouncer STS integration design 3.1).
 *
 * `apps/web` and `apps/ai-gateway` install one `BouncerAuth` from `instrumentation.ts`, with the
 * Bouncer scopes their STS policy grants (`BOUNCER_APP_SCOPES`). Every call names its caller in
 * `x-kilo-caller`, whatever the mode says. With `BOUNCER_CLIENT_AUTH=dual` a call to
 * `BOUNCER_STS_ORIGIN` also carries `Authorization: Bearer <STS token>` for the route's scope, next
 * to the unchanged `x-internal-api-key`: Bouncer's `legacy` mode ignores the bearer and its `dual`
 * mode verifies it. With `sts` the call carries the token and no `x-internal-api-key` at all
 * (`bouncerSendsLegacyKey`), so the legacy secret stays unused. Scripts and tests install nothing,
 * so they send neither the caller nor a token.
 *
 * Tokens: the token client keeps each token in memory; a read after 80 % of a token's lifetime
 * starts its renewal in the background. Every call reads all of the app's granted scopes (the
 * route's own, plus the others in the background), one read per scope at a time, so a rarely used
 * scope is renewed by the traffic of the others.
 *
 * Budgets: a call whose route waits (decide, charge-decide, signup-decide) waits at most
 * `BOUNCER_TOKEN_WAIT_MS` for a token it does not hold, out of the call's own deadline, and only
 * when the deployment's exchanged Vercel token is already held, so the mint is one STS call. A
 * deployment's first calls, while its exchange (and the jitter before its first mint) runs, wait
 * 0 (`exchange_pending`). Every other route never waits. A call without a token proceeds with the
 * legacy key alone. While the breaker is closed, waits that run out count at most once per
 * `BOUNCER_TOKEN_WAIT_MS`, so `BOUNCER_BREAKER_THRESHOLD` counts take about 2.5 s of continuous
 * timeouts; a token that arrives within a wait resets the count. An open breaker sets the wait to
 * 0 until any mint succeeds. In `dual`, after Bouncer refuses a scope's token as the token's fault
 * (401 `invalid_token` or 403 `insufficient_scope`, `bouncerRefusalBlamesToken`), that scope's
 * token is held back for `BOUNCER_REJECTED_HOLD_MS`; a 401 that names no token error is the legacy
 * key's failure (Bouncer's `legacy` mode ignores the bearer) and holds nothing back. In `sts`
 * nothing is held back: Bouncer ignores the legacy key there, so a call without the token is a
 * certain refusal. Every refusal is counted under its reason in either mode.
 *
 * This module stays light: the token client, the Vercel OIDC exchange and the Runtime Cache load
 * on the first call with the flag on, or at install when the flag is already on
 * (`sts-token-transport.ts`).
 */

/** The headers one Bouncer call adds besides `content-type` and `x-internal-api-key`. */
export type BouncerAuthHeaders = Readonly<Record<string, string>>;

/**
 * One call: its scope, whether its route waits for a token it does not hold, the origin of the
 * endpoint it goes to, and the call's deadline, which also ends the wait.
 */
export type BouncerAuthCall = {
  scope: BouncerScope;
  wait: boolean;
  origin: string;
  signal?: AbortSignal;
};

/** `BOUNCER_CLIENT_AUTH` as read; `invalid` sends the legacy key alone. */
export type BouncerClientAuthMode = 'legacy' | 'dual' | 'sts' | 'invalid';

/**
 * Why Bouncer refused a call that carried a token: the RFC 6750 `error` its `WWW-Authenticate`
 * answer names (`invalid_token` with 401, `insufficient_scope` with 403), `legacy_key` for a 401
 * that names neither (the legacy key failed: Bouncer's `legacy` mode ignores the bearer), or
 * `http_403` for a 403 that names neither.
 */
export type BouncerTokenRefusalReason =
  | 'invalid_token'
  | 'insufficient_scope'
  | 'legacy_key'
  | 'http_403';

export type BouncerTokenRefusal = { status: 401 | 403; reason: BouncerTokenRefusalReason };

/** Whether Bouncer refused the token itself, the only refusal a hold-back or a retry can help. */
export function bouncerRefusalBlamesToken(reason: BouncerTokenRefusalReason): boolean {
  return reason === 'invalid_token' || reason === 'insufficient_scope';
}

export type BouncerAuth = {
  /** The mode the flag names now. */
  mode(): BouncerClientAuthMode;
  headers(call: BouncerAuthCall): Promise<BouncerAuthHeaders>;
  /** Bouncer answered 401 or 403 to a call that carried this scope's token. */
  refused(scope: BouncerScope, refusal: BouncerTokenRefusal): void;
};

/** The only origin a token goes to: production Bouncer, the only Bouncer that accepts one. */
export const BOUNCER_STS_ORIGIN = 'https://bouncer.kiloapps.io';
/** Design 3.1: a caller reads its token within 250 ms of its own. */
export const BOUNCER_TOKEN_WAIT_MS = 250;
/**
 * Design 3.1: counted timeouts before the breaker opens. A count is taken at most once per
 * `BOUNCER_TOKEN_WAIT_MS`, so the breaker opens after about 2.5 s of continuous timeouts.
 */
export const BOUNCER_BREAKER_THRESHOLD = 10;
/**
 * How long a scope's token is held back after Bouncer refused the token itself
 * (`bouncerRefusalBlamesToken`), in `dual` only. This hold-back and the client's retry without the
 * token exist only while `x-internal-api-key` is accepted; `sts` has neither, and the change that
 * removes the legacy key (main design 9.5) removes both.
 */
export const BOUNCER_REJECTED_HOLD_MS = 60_000;
/**
 * One `bouncer_sts_tokens` line per instance per this interval, with every count since the
 * previous line. It is written by the first call after the interval ends, so an idle instance
 * writes nothing.
 */
export const BOUNCER_COUNT_LOG_INTERVAL_MS = 60_000;

/**
 * Why a call went without a token.
 * - `timeout`: a wait ran out while a mint was running (steady state).
 * - `readiness_timeout`: the check for the exchanged Vercel token outlasted the wait (steady state).
 * - `breaker_open`: the breaker skipped the wait.
 * - `exchange_pending`: the deployment's exchanged Vercel token is not held yet, or its first mint
 *   is still in its jitter, so no wait.
 * - `not_held`: the route never waits and no fresh token was held.
 * - `aborted`: the call's own deadline or its caller ended the wait.
 * - `rejected`: Bouncer refused this scope's token within the hold (`dual` only).
 * - `denied`, `unavailable`: the token client's answer.
 * - `load`: the transport did not load.
 * - `config`: the flag, the deployment's STS settings, a scope the app is not granted, or an
 *   endpoint other than `BOUNCER_STS_ORIGIN`.
 */
export type BouncerTokenMissReason =
  | 'timeout'
  | 'readiness_timeout'
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
 * `BOUNCER_CLIENT_AUTH`, the repository's caller-auth mode convention: `legacy` (unset or empty
 * too) sends the legacy key alone; `dual` sends it and an STS token; `sts` sends the STS token
 * alone. Any other value sends the legacy key alone and counts as a `config` miss, so a typo can
 * never stop Bouncer calls.
 */
export function bouncerClientAuthMode(value: string | undefined): BouncerClientAuthMode {
  if (value === undefined || value === '' || value === 'legacy') return 'legacy';
  if (value === 'dual' || value === 'sts') return value;
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
  /**
   * Loads the transport once, with the hooks it reports mints through; a rejection marks a `load`
   * (or `config`) miss and is retried on the next call.
   */
  loadTransport: (hooks: BouncerTransportHooks) => Promise<BouncerTransport>;
  waitUntil: (promise: Promise<unknown>) => void;
  /** Starts loading the transport now (no network call), so the first call does not import it. */
  preload?: boolean;
  /**
   * Starts one read per granted scope now, so the exchange, the first-mint jitter and the mint run
   * at startup instead of on the first calls. Used in `sts`, where a call without its token has no
   * legacy fallback. Each read's outcome is counted under `prewarm`; nothing is thrown.
   */
  prewarm?: boolean;
  now?: () => number;
  log?: (line: string, level: 'info' | 'warn') => void;
};

export function createBouncerAuth(options: BouncerAuthOptions): BouncerAuth {
  const now = options.now ?? Date.now;
  const log =
    options.log ?? ((line, level) => (level === 'warn' ? console.warn(line) : console.info(line)));
  /** Tells this instance's lines apart, so counts per instance can be summed and compared. */
  const instance = crypto.randomUUID();
  const callerHeaders: BouncerAuthHeaders = { 'x-kilo-caller': options.caller };
  const ctx = { waitUntil: options.waitUntil };
  let loading: Promise<BouncerTransport> | null = null;
  /** The pending read of each scope; every call for that scope reuses it until it settles. */
  const inflight = new Map<BouncerScope, Promise<string>>();
  /** Counted timeouts while the breaker is closed; at the threshold the breaker is open. */
  let timeouts = 0;
  let countedAt: number | null = null;
  const rejectedUntil = new Map<BouncerScope, number>();
  let refused: Record<string, Record<string, number>> = {};
  let prewarm: Record<string, Record<string, number>> = {};
  let attached: Record<string, number> = {};
  let missed: Record<string, Record<string, number>> = {};
  let mints = { ok: 0, failed: 0 };
  let lastMintAt: number | null = null;
  let flushedAt: number | null = null;

  function line(event: string, fields: Record<string, unknown> = {}): string {
    return JSON.stringify({ event, instance, caller: options.caller, ...fields });
  }

  const breakerOpen = () => timeouts >= BOUNCER_BREAKER_THRESHOLD;

  const hooks: BouncerTransportHooks = {
    mint(ok) {
      if (!ok) {
        mints.failed += 1;
        return;
      }
      mints.ok += 1;
      lastMintAt = now();
      if (!breakerOpen()) return;
      log(line('bouncer_sts_breaker_closed'), 'warn');
      timeouts = 0;
    },
  };

  function load(): Promise<BouncerTransport> {
    loading ??= options.loadTransport(hooks).catch((error: unknown) => {
      loading = null;
      throw error instanceof BouncerStsConfigError ? error : new BouncerTransportLoadError(error);
    });
    return loading;
  }
  if (options.preload) void load().catch(() => undefined);

  /** Writes the counts when the interval has ended; the first count of the instance writes too. */
  function flushIfDue(): void {
    const at = now();
    if (flushedAt !== null && at - flushedAt < BOUNCER_COUNT_LOG_INTERVAL_MS) return;
    const lastMintAgeSeconds = lastMintAt === null ? null : Math.round((at - lastMintAt) / 1000);
    log(
      line('bouncer_sts_tokens', {
        attached,
        missed,
        refused,
        prewarm,
        mint: mints,
        last_mint_age_s: lastMintAgeSeconds,
      }),
      'info'
    );
    attached = {};
    missed = {};
    refused = {};
    prewarm = {};
    mints = { ok: 0, failed: 0 };
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

  /**
   * The scope's pending read, or a new one. A new read is handed to `waitUntil` once, so a mint it
   * starts outlives the response; every call during that mint reuses it.
   */
  function readScope(transport: Promise<BouncerTransport>, scope: BouncerScope): Promise<string> {
    const pending = inflight.get(scope);
    if (pending !== undefined) return pending;
    const reading = transport.then(t => t.read({ audience: 'bouncer', scope }, ctx));
    inflight.set(scope, reading);
    const settle = () => {
      if (inflight.get(scope) === reading) inflight.delete(scope);
    };
    options.waitUntil(reading.then(settle, settle));
    return reading;
  }

  /** Reads the app's other granted scopes, except one already being read, so renewals start. */
  function warmSiblings(transport: Promise<BouncerTransport>, scope: BouncerScope): void {
    for (const other of options.scopes) {
      // `readScope` handles the read's rejection itself and hands it to `waitUntil`.
      if (other !== scope && !inflight.has(other)) void readScope(transport, other);
    }
  }

  /** Counts a wait that ran out toward the breaker, at most once per `BOUNCER_TOKEN_WAIT_MS`. */
  function countTimeout(): void {
    if (breakerOpen()) return;
    const at = now();
    if (countedAt !== null && at - countedAt < BOUNCER_TOKEN_WAIT_MS) return;
    countedAt = at;
    timeouts += 1;
    if (breakerOpen()) log(line('bouncer_sts_breaker_open'), 'warn');
  }

  if (options.prewarm) {
    const transport = load();
    for (const scope of options.scopes) {
      const count = (outcome: string) => {
        const byOutcome = (prewarm[scope] ??= {});
        byOutcome[outcome] = (byOutcome[outcome] ?? 0) + 1;
        flushIfDue();
      };
      void readScope(transport, scope).then(
        () => count('ok'),
        (error: unknown) => count(missReasonOf(error))
      );
    }
  }

  return {
    mode: () => bouncerClientAuthMode(options.flag()),

    refused(scope, { reason }) {
      if (!options.scopes.includes(scope)) return;
      const byReason = (refused[scope] ??= {});
      byReason[reason] = (byReason[reason] ?? 0) + 1;
      flushIfDue();
      // Only `dual` holds a refused token back: there the legacy key still carries the call. A
      // refusal of the legacy key is not the token's fault, so it holds nothing back.
      if (!bouncerRefusalBlamesToken(reason)) return;
      if (bouncerClientAuthMode(options.flag()) !== 'dual') return;
      const held = (rejectedUntil.get(scope) ?? 0) > now();
      rejectedUntil.set(scope, now() + BOUNCER_REJECTED_HOLD_MS);
      if (!held) log(line('bouncer_sts_token_rejected', { scope }), 'warn');
    },

    async headers({ scope, wait, origin, signal }) {
      const mode = bouncerClientAuthMode(options.flag());
      if (mode === 'invalid') return miss('config', scope);
      if (mode === 'legacy') return callerHeaders;
      if (!options.scopes.includes(scope) || origin !== BOUNCER_STS_ORIGIN) {
        return miss('config', scope);
      }
      // The whole wait, the held check and the readiness check included, counts from here.
      const started = now();
      const transport = load();
      // Settled by the reads below; their rejection reaches the caller there.
      void transport.catch(() => undefined);
      const reading = readScope(transport, scope);
      // The siblings join only once the route's own read settles (in steady state, the same
      // tick): a read that joins another's attempt is not woken by its answer, so a later
      // waiting call that reused it would see its token late.
      void reading.then(
        () => warmSiblings(transport, scope),
        () => undefined
      );
      if (mode === 'dual' && (rejectedUntil.get(scope) ?? 0) > now()) {
        return miss('rejected', scope);
      }

      const held = await race(reading, 0, signal);
      if (held === 'aborted') return miss('aborted', scope);
      if (held !== 'waited') {
        return 'value' in held ? attach(scope, held.value) : miss(missReasonOf(held.error), scope);
      }

      // No fresh token: a mint is running.
      if (!wait) return miss('not_held', scope);
      if (breakerOpen()) return miss('breaker_open', scope);

      // In `dual` a call waits only when the mint is one STS call away; without a wait it still
      // carries the legacy key. `sts` has no such fallback (a call without the token is refused),
      // so there an admission call waits for the mint even on a cold instance, within the same
      // budget and deadline, and its mint skips the 0 to 2 s first-mint jitter, which would
      // outlast the wait.
      if (mode === 'sts') void transport.then(t => t.skipJitter(), () => undefined);
      if (mode === 'dual') {
        const ready = await race(
          transport.then(t => t.exchangeReady()),
          BOUNCER_TOKEN_WAIT_MS - (now() - started),
          signal
        );
        if (ready === 'aborted') return miss('aborted', scope);
        if (ready === 'waited') {
          countTimeout();
          return miss('readiness_timeout', scope);
        }
        if (!('value' in ready) || !ready.value) return miss('exchange_pending', scope);
      }

      const minted = await race(reading, BOUNCER_TOKEN_WAIT_MS - (now() - started), signal);
      if (minted === 'aborted') return miss('aborted', scope);
      if (minted === 'waited') {
        countTimeout();
        return miss('timeout', scope);
      }
      if (!('value' in minted)) return miss(missReasonOf(minted.error), scope);
      // A token arrived within the wait: the mint path answers in time again.
      if (!breakerOpen()) timeouts = 0;
      return attach(scope, minted.value);
    },
  };
}

declare global {
  // Next.js evaluates a module once per bundle layer, so the auth an app installs from
  // `instrumentation.ts` reaches its route handlers only through a process-wide slot.
  var __kilocodeBouncerAuth: BouncerAuth | undefined;
}

/**
 * Installs the auth for `caller` with the Bouncer scopes its STS policy grants
 * (`BOUNCER_APP_SCOPES`); called once from the `instrumentation.ts` of `apps/web` and
 * `apps/ai-gateway`. In `dual` or `sts` it starts importing the transport (no network call); in
 * `sts` it also starts reading every granted scope when the function has its OIDC token outside a
 * request, so the first mint runs at startup. In `legacy` nothing loads, and the flag is still read
 * on every call.
 */
export function installBouncerAuth(caller: BouncerCaller): void {
  globalThis.__kilocodeBouncerAuth = createBouncerAuth({
    caller,
    scopes: BOUNCER_APP_SCOPES[caller],
    flag: () => process.env.BOUNCER_CLIENT_AUTH,
    loadTransport: async hooks => {
      // Lazy on purpose, as `sts-secret-reader.ts` does: a deployment with the flag off never loads
      // the token client, the Vercel OIDC exchange or the Runtime Cache.
      const { createBouncerTransport } =
        await import('@kilocode/web-shared/lib/bouncer/sts-token-transport');
      return createBouncerTransport(hooks);
    },
    waitUntil,
    preload: ['dual', 'sts'].includes(bouncerClientAuthMode(process.env.BOUNCER_CLIENT_AUTH)),
    // At startup there is no request, so no `x-vercel-oidc-token` header: the identity comes from
    // `VERCEL_OIDC_TOKEN_FILE` or `VERCEL_OIDC_TOKEN` (`@vercel/oidc`). Without either, a startup
    // read would fail and put the scope into the token client's backoff, so it is skipped and the
    // first calls mint within their own wait.
    prewarm:
      bouncerClientAuthMode(process.env.BOUNCER_CLIENT_AUTH) === 'sts' &&
      Boolean(process.env.VERCEL_OIDC_TOKEN_FILE || process.env.VERCEL_OIDC_TOKEN),
  });
}

/** The installed auth's headers for one call; none in a process that installed nothing. */
export async function bouncerAuthHeaders(call: BouncerAuthCall): Promise<BouncerAuthHeaders> {
  const auth = globalThis.__kilocodeBouncerAuth;
  return auth === undefined ? {} : auth.headers(call);
}

/**
 * Whether a call sends `x-internal-api-key`: every mode but `sts`, and always in a process that
 * installed nothing (scripts, tests).
 */
export function bouncerSendsLegacyKey(): boolean {
  return globalThis.__kilocodeBouncerAuth?.mode() !== 'sts';
}

/** Reports Bouncer's refusal of a call's token; a no-op without an auth. */
export function bouncerTokenRefused(scope: BouncerScope, refusal: BouncerTokenRefusal): void {
  globalThis.__kilocodeBouncerAuth?.refused(scope, refusal);
}
