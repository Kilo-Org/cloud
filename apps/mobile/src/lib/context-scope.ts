import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { isSignOutActive } from '@/lib/auth/sign-out-state';

export type AuthenticatedOwner = Readonly<{
  authEpoch: number;
  generation: number;
  userId: string | null;
  /**
   * True only when the active credentials were read back from storage on this
   * process's bootstrap (a cold start), and false once `beginAuthenticatedOwner`
   * revokes ownership for a sign-in or sign-out. The persisted identity hint
   * may scope local data only for a restored session: during a credential
   * switch the hint still names the previous account, so a fresh sign-in's
   * credentials must be confirmed by `user.getMe` before any account-scoped
   * read (offline cached transcript, translations) may use the hint.
   */
  restored: boolean;
}>;

let owner: AuthenticatedOwner = Object.freeze({
  authEpoch: currentAuthEpoch(),
  generation: 0,
  userId: null,
  restored: false,
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
  return publish({
    authEpoch: currentAuthEpoch(),
    generation: owner.generation + 1,
    userId: null,
    restored: false,
  });
}

/**
 * Marks the active credentials as restored from storage on bootstrap: the one
 * state in which the persisted identity hint may scope local data while the
 * live owner is still unconfirmed. A fresh `signIn` calls
 * {@link beginAuthenticatedOwner}, which clears this again.
 */
export function markRestoredAuthenticatedOwner(): AuthenticatedOwner {
  return publish({ ...owner, restored: true });
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
