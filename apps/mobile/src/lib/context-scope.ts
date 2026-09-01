import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';

export type AuthenticatedOwner = Readonly<{
  authEpoch: number;
  generation: number;
  userId: string | null;
}>;

let owner: AuthenticatedOwner = Object.freeze({
  authEpoch: currentAuthEpoch(),
  generation: 0,
  userId: null,
});
const listeners = new Set<() => void>();

export function getAuthenticatedOwner(): AuthenticatedOwner {
  return owner;
}

export function subscribeAuthenticatedOwner(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(next: AuthenticatedOwner): AuthenticatedOwner {
  owner = Object.freeze(next);
  for (const listener of listeners) {
    listener();
  }
  return owner;
}

/** Revoke ownership before changing credentials. Ordinary refresh does not call this. */
export function beginAuthenticatedOwner(): AuthenticatedOwner {
  return publish({ authEpoch: currentAuthEpoch(), generation: owner.generation + 1, userId: null });
}

export function isCurrentOwner(captured: AuthenticatedOwner): boolean {
  return (
    !isSignOutActive() &&
    isCurrentAuthEpoch(captured.authEpoch) &&
    captured.authEpoch === owner.authEpoch &&
    captured.generation === owner.generation &&
    (captured.userId === null || captured.userId === owner.userId)
  );
}

/** Only a getMe response requested under committed credentials can confirm this generation. */
export function confirmAuthenticatedOwner(captured: AuthenticatedOwner, userId: string): boolean {
  if (!userId || !isCurrentOwner(captured) || (owner.userId !== null && owner.userId !== userId)) {
    return false;
  }
  if (owner.userId === null) {
    publish({ ...owner, userId });
  }
  return true;
}

export function isAuthenticatedOwner(captured: AuthenticatedOwner): boolean {
  return captured.userId !== null && isCurrentOwner(captured);
}
