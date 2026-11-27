/**
 * The types and the error shared by the Bouncer STS auth (`sts-auth.ts`) and its lazily loaded
 * transport (`sts-token-transport.ts`). A leaf: it imports nothing, so neither module imports the
 * other statically and the import graph has no cycle.
 */

/** The Bouncer scopes the shared client sends; the signup-history import job's scope is not one. */
export type BouncerScope = 'bouncer:decide' | 'bouncer:usage.write' | 'bouncer:signup.decide';

/** Reads one token, from memory when the client holds a fresh one (`ServiceTokens.get`). */
export type BouncerTokenRead = (
  target: { audience: 'bouncer'; scope: BouncerScope },
  ctx: { waitUntil(promise: Promise<unknown>): void }
) => Promise<string>;

/** A deployment whose STS settings cannot mint Bouncer tokens: no STS environment, a wrong issuer. */
export class BouncerStsConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BouncerStsConfigError';
  }
}
