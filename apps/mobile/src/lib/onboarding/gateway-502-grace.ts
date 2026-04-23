/**
 * Pure helper for the gateway 502-grace sub-machine.
 *
 * The reducer in `./machine.ts` records `first502AtMs` on the first 502
 * observation and clears it on any non-502. This helper lets a component
 * poll the current clock on a 1s interval (or any interval) and decide
 * whether to dispatch `gateway-grace-elapsed` without owning any of the
 * grace logic itself.
 */

import { GATEWAY_502_GRACE_MS } from './machine';

/**
 * Returns true iff the reducer has been holding a 502 for longer than the
 * grace window as of `nowMs`. Takes just the `first502AtMs` slice so a
 * component can call this from a narrow-deps effect without capturing the
 * full state object.
 */
export function checkGraceExpired(grace: { first502AtMs: number | null }, nowMs: number): boolean {
  if (grace.first502AtMs === null) {
    return false;
  }
  return nowMs - grace.first502AtMs >= GATEWAY_502_GRACE_MS;
}

export { GATEWAY_502_GRACE_MS };
