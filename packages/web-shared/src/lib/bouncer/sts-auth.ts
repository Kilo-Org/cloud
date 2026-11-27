import 'server-only';
import { waitUntil } from '@vercel/functions';

/**
 * The STS service tokens the shared Bouncer client sends (Bouncer STS integration design 3.1).
 *
 * `apps/web` and `apps/ai-gateway` install one `BouncerAuth` from `instrumentation.ts`. Every call
 * then names its caller in `x-kilo-caller` (`kilocode-app` or `kilocode-ai-gateway`, the names
 * Bouncer counts legacy calls by). With `BOUNCER_STS_TOKENS=on` the call also carries
 * `Authorization: Bearer <STS token>` for the route's scope, next to the unchanged
 * `x-internal-api-key`: Bouncer's `legacy` mode ignores the bearer and its `dual` mode verifies it.
 * Scripts and tests install nothing, so they send neither header.
 *
 * Budgets: the token client keeps each token in memory and renews it in the background at 80 % of
 * its lifetime, so a warm instance reads it with no network call. An admission call
 * (`bouncer:decide`, `bouncer:signup.decide`) waits at most `BOUNCER_TOKEN_WAIT_MS` for a token it
 * does not hold, and never past the call's own deadline (`signal`), which also bounds the request
 * that follows, so the wait never lengthens the call. A write (`bouncer:usage.write`), whose
 * durable outbox retries it, never waits. A call without a token proceeds with the legacy key
 * alone and is counted, and so is a call that sends one. After `BOUNCER_BREAKER_THRESHOLD`
 * consecutive admission waits that ran out, the wait drops to 0 until a mint succeeds. The mint
 * keeps running under the request's `waitUntil` after a call stops waiting for it.
 *
 * This module stays light: the token client, the Vercel OIDC exchange and the Runtime Cache load
 * on the first call with the flag on (`sts-token-transport.ts`).
 */

/** The `x-kilo-caller` names, the STS workload names of design 5 that Bouncer counts. */
export type BouncerCaller = 'kilocode-app' | 'kilocode-ai-gateway';

/** The Bouncer scopes the shared client sends; the web app's signup history has no runtime caller. */
export type BouncerScope = 'bouncer:decide' | 'bouncer:usage.write' | 'bouncer:signup.decide';

/** The headers one Bouncer call adds besides `content-type` and `x-internal-api-key`. */
export type BouncerAuthHeaders = Readonly<Record<string, string>>;

/** The headers for one call; `signal` is the call's deadline, which ends the token wait too. */
export type BouncerAuth = (
  scope: BouncerScope,
  signal?: AbortSignal
) => Promise<BouncerAuthHeaders>;

/** Reads one token, from memory when the client holds a fresh one (`ServiceTokens.get`). */
export type BouncerTokenRead = (
  target: { audience: 'bouncer'; scope: BouncerScope },
  ctx: { waitUntil(promise: Promise<unknown>): void }
) => Promise<string>;

/** Design 3.1: a caller reads its token within 250 ms of its own. */
export const BOUNCER_TOKEN_WAIT_MS = 250;
/** Design 3.1: consecutive admission waits that ran out before the breaker sets the wait to 0. */
export const BOUNCER_BREAKER_THRESHOLD = 10;
/**
 * One `bouncer_sts_token_missed` line per reason and scope, and one `bouncer_sts_token_attached`
 * line per scope, per this interval and instance, each with the count since the previous line.
 */
export const BOUNCER_COUNT_LOG_INTERVAL_MS = 60_000;

const ADMISSION_SCOPES: Readonly<Record<BouncerScope, boolean>> = {
  'bouncer:decide': true,
  'bouncer:signup.decide': true,
  'bouncer:usage.write': false,
};

/**
 * Why a call went without a token. `timeout`: an admission wait ran out; `breaker_open`: the
 * breaker skipped the wait; `not_held`: a write found no fresh token and never waits; `denied` and
 * `unavailable`: the token client's answer; `load`: the transport did not load; `config`: the flag
 * or the deployment's STS settings are invalid.
 */
export type BouncerTokenMissReason =
  | 'timeout'
  | 'breaker_open'
  | 'not_held'
  | 'denied'
  | 'unavailable'
  | 'load'
  | 'config';

/** A deployment whose STS settings cannot mint Bouncer tokens: no STS environment, a wrong issuer. */
export class BouncerStsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BouncerStsConfigError';
  }
}

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

const SETTLED = Symbol('settled');

type Raced = { token: string } | { error: unknown } | typeof SETTLED;

/**
 * `promise`, or `SETTLED` once `ms` passes or `signal` aborts first; a held token wins a 0 ms
 * race.
 */
async function within(promise: Promise<string>, ms: number, signal?: AbortSignal): Promise<Raced> {
  const timer = Promise.withResolvers<typeof SETTLED>();
  const settle = () => timer.resolve(SETTLED);
  const handle = setTimeout(settle, ms);
  if (signal?.aborted) settle();
  signal?.addEventListener('abort', settle, { once: true });
  try {
    return await Promise.race([
      promise.then(
        token => ({ token }),
        (error: unknown) => ({ error })
      ),
      timer.promise,
    ]);
  } finally {
    clearTimeout(handle);
    signal?.removeEventListener('abort', settle);
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
  /** The flag's current value; read on every call. */
  flag: () => string | undefined;
  /** Loads the token client once; a rejection marks a `load` (or `config`) miss and is retried. */
  loadTokens: () => Promise<BouncerTokenRead>;
  waitUntil: (promise: Promise<unknown>) => void;
  now?: () => number;
  log?: (line: string) => void;
};

export function createBouncerAuth(options: BouncerAuthOptions): BouncerAuth {
  const now = options.now ?? Date.now;
  const log = options.log ?? (line => console.warn(line));
  const callerHeaders: BouncerAuthHeaders = { 'x-kilo-caller': options.caller };
  let loading: Promise<BouncerTokenRead> | null = null;
  let timeouts = 0;
  const counts = new Map<string, { count: number; loggedAt: number | null }>();

  function load(): Promise<BouncerTokenRead> {
    loading ??= options.loadTokens().catch((error: unknown) => {
      loading = null;
      throw error instanceof BouncerStsConfigError ? error : new BouncerTransportLoadError(error);
    });
    return loading;
  }

  /**
   * Counts one call under `event` and `fields`; logs it with the count since the last line, once
   * per interval per event and fields. The fields are fixed names, never a token or error text.
   */
  function count(event: string, fields: Readonly<Record<string, string>>): void {
    const key = JSON.stringify([event, fields]);
    const entry = counts.get(key) ?? { count: 0, loggedAt: null };
    entry.count += 1;
    const at = now();
    if (entry.loggedAt === null || at - entry.loggedAt >= BOUNCER_COUNT_LOG_INTERVAL_MS) {
      log(JSON.stringify({ event, caller: options.caller, ...fields, count: entry.count }));
      entry.count = 0;
      entry.loggedAt = at;
    }
    counts.set(key, entry);
  }

  function miss(reason: BouncerTokenMissReason, scope: BouncerScope): void {
    count('bouncer_sts_token_missed', { reason, scope });
  }

  function succeeded(): void {
    if (timeouts >= BOUNCER_BREAKER_THRESHOLD) {
      log(JSON.stringify({ event: 'bouncer_sts_breaker_closed', caller: options.caller }));
    }
    timeouts = 0;
  }

  return async (scope, signal) => {
    const enabled = bouncerStsTokensEnabled(options.flag());
    if (enabled === 'invalid') miss('config', scope);
    if (enabled !== true) return callerHeaders;

    const admission = ADMISSION_SCOPES[scope];
    const breakerOpen = timeouts >= BOUNCER_BREAKER_THRESHOLD;
    const waitMs = admission && !breakerOpen ? BOUNCER_TOKEN_WAIT_MS : 0;
    const ctx = { waitUntil: options.waitUntil };
    const reading = load().then(read => read({ audience: 'bouncer', scope }, ctx));
    void reading.then(succeeded, () => undefined);

    const raced = await within(reading, waitMs, signal);
    if (raced === SETTLED) {
      // The mint runs on past the response; the next call finds its token.
      options.waitUntil(reading.catch(() => undefined));
      if (waitMs > 0) {
        timeouts += 1;
        if (timeouts === BOUNCER_BREAKER_THRESHOLD) {
          log(JSON.stringify({ event: 'bouncer_sts_breaker_open', caller: options.caller }));
        }
        miss('timeout', scope);
      } else {
        miss(admission ? 'breaker_open' : 'not_held', scope);
      }
      return callerHeaders;
    }
    if ('error' in raced) {
      miss(missReasonOf(raced.error), scope);
      return callerHeaders;
    }
    count('bouncer_sts_token_attached', { scope });
    return { ...callerHeaders, authorization: `Bearer ${raced.token}` };
  };
}

declare global {
  // Next.js evaluates a module once per bundle layer, so the auth an app installs from
  // `instrumentation.ts` reaches its route handlers only through a process-wide slot.
  var __kilocodeBouncerAuth: BouncerAuth | undefined;
}

/**
 * Installs the auth for `caller`; called once from the `instrumentation.ts` of `apps/web` and
 * `apps/ai-gateway`. Installing builds and loads nothing: the flag is read on every call, and the
 * transport loads on the first call with the flag on.
 */
export function installBouncerAuth(caller: BouncerCaller): void {
  globalThis.__kilocodeBouncerAuth = createBouncerAuth({
    caller,
    flag: () => process.env.BOUNCER_STS_TOKENS,
    loadTokens: async () => {
      // Lazy on purpose, as `sts-secret-reader.ts` does: a deployment with the flag off never loads
      // the token client, the Vercel OIDC exchange or the Runtime Cache.
      const { createBouncerTokenRead } =
        await import('@kilocode/web-shared/lib/bouncer/sts-token-transport');
      return createBouncerTokenRead();
    },
    waitUntil,
  });
}

/** The installed auth's headers for one call; none in a process that installed nothing. */
export async function bouncerAuthHeaders(
  scope: BouncerScope,
  signal?: AbortSignal
): Promise<BouncerAuthHeaders> {
  const auth = globalThis.__kilocodeBouncerAuth;
  return auth === undefined ? {} : auth(scope, signal);
}
