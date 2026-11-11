import { type PendingLinkOffer } from '@/lib/auth/native-auth-contract';
import { type PendingLinkOutcome } from '@/lib/auth/pending-link';

/**
 * The pending link a sign-in is resolving, and the outcome of the last one.
 *
 * Both live here rather than in the login screen because that screen unmounts on an activity
 * restart while the browser sign-in is open and right after the device approved one. A remount
 * reads the offer back, so the same link keeps its screen instead of falling back to the plain
 * landing, and reads the outcome back so the person still learns whether the provider was added.
 *
 * The token is a secret, so this is process memory only: nothing here reaches the disk, and a
 * fresh process starts with neither.
 */
let offer: PendingLinkOffer | null = null;
let outcome: PendingLinkOutcome | undefined = undefined;

export function readPendingLinkOffer(): PendingLinkOffer | null {
  return offer;
}

/** A new link supersedes the one it replaces, and the outcome of that one with it. */
export function setPendingLinkOffer(next: PendingLinkOffer | null): void {
  offer = next;
  outcome = undefined;
}

export function recordPendingLinkOutcome(next: PendingLinkOutcome): void {
  outcome = next;
}

/** Reads the outcome once; a later read finds nothing, so the person is told exactly once. */
export function takePendingLinkOutcome(): PendingLinkOutcome | undefined {
  const taken = outcome;
  outcome = undefined;
  return taken;
}
