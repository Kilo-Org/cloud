import type {
  STS_BOUNCER_DECIDE,
  STS_BOUNCER_SIGNUP_DECIDE,
  STS_BOUNCER_USAGE_WRITE,
} from '@kilocode/sts-contracts';

/**
 * The types, the error and the per-app scope table shared by the Bouncer STS auth (`sts-auth.ts`)
 * and its lazily loaded transport (`sts-token-transport.ts`). A leaf: its one import is type-only,
 * so neither module imports the other statically and the import graph has no cycle.
 */

/**
 * The Bouncer scopes the shared client sends, from the registered pairs of `@kilocode/sts-contracts`;
 * the signup-history import job's scope is not one.
 */
export type BouncerScope = (
  | typeof STS_BOUNCER_DECIDE
  | typeof STS_BOUNCER_USAGE_WRITE
  | typeof STS_BOUNCER_SIGNUP_DECIDE
)['scope'];

/**
 * The `x-kilo-caller` values: the labels Bouncer's legacy-call counters accept (`KNOWN_CALLERS` in
 * Kilo-Org/bouncer `src/api-auth.ts`). They are counting labels, not STS workload names: Bouncer
 * attributes a call that carries a token by the token's `sub` (`service:web`, `service:ai-gateway`).
 */
export type BouncerCaller = 'kilocode-app' | 'kilocode-ai-gateway';

/**
 * The Bouncer scopes each app's STS policy grants in production (`services/sts/policy/web.yaml`
 * and `ai-gateway.yaml`, `environmentGrants.production`);
 * `services/sts/test/repo/bouncer-app-scopes.test.ts` reads this table as text and checks the two
 * stay equal, so keep its one-line-per-app shape. The auth reads no other scope.
 */
export const BOUNCER_APP_SCOPES: Readonly<Record<BouncerCaller, readonly BouncerScope[]>> = {
  'kilocode-app': ['bouncer:decide', 'bouncer:usage.write', 'bouncer:signup.decide'],
  'kilocode-ai-gateway': ['bouncer:decide', 'bouncer:usage.write'],
};

/** What the transport reports back to the auth: each STS mint answer, HTTP 2xx or not. */
export type BouncerTransportHooks = {
  mint(ok: boolean): void;
};

/** Reads one token, from memory when the client holds a fresh one (`ServiceTokens.get`). */
export type BouncerTokenRead = (
  target: { audience: 'bouncer'; scope: BouncerScope },
  ctx: { waitUntil(promise: Promise<unknown>): void }
) => Promise<string>;

/**
 * What the lazily loaded transport gives the auth: the token read, whether the deployment's
 * exchanged Vercel token is already held (instance memory or the shared Runtime Cache), so a mint
 * now takes one STS call and no Vercel exchange (readiness never exchanges or writes anything), and
 * `skipJitter`, a one-shot request that the next first-mint jitter decision consumes (it skips that
 * jitter, or ends one already running), however long the exchange before it takes: a call that
 * waits for its token in `sts` has no legacy fallback, so its mint must not sit out a 0 to 2 s
 * jitter. The request also clears when that mint settles.
 */
export type BouncerTransport = {
  read: BouncerTokenRead;
  exchangeReady(): Promise<boolean>;
  skipJitter(): void;
};

/** A deployment whose STS settings cannot mint Bouncer tokens: no STS environment, a wrong issuer. */
export class BouncerStsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BouncerStsConfigError';
  }
}
