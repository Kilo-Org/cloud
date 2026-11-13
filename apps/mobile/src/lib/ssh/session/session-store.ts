import { type SshSession } from './types';

/**
 * The open sessions, outside React: the native connections outlive any one
 * screen, so the screen reads a snapshot instead of owning the state.
 *
 * Every write replaces the whole session object, so a subscriber that compares
 * by identity sees exactly the sessions that changed.
 */
const sessions = new Map<string, SshSession>();
const listeners = new Set<() => void>();
let snapshot: readonly SshSession[] = [];
let rehydrated = false;

export function subscribeSessions(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Oldest first: the order the switcher lists them in. */
export function sessionList(): readonly SshSession[] {
  return snapshot;
}

/**
 * Whether this runtime has finished adopting what the native registry kept.
 *
 * The store starts empty in every runtime, so before this turns true a missing
 * session means "not read yet", not "ended": a screen restored onto a live
 * connection must not report its absence as a close.
 */
export function sessionsRehydrated(): boolean {
  return rehydrated;
}

/** Marks the adoption pass finished, so a screen may trust an absent session. */
export function markSessionsRehydrated(): void {
  if (rehydrated) {
    return;
  }
  rehydrated = true;
  publish();
}

export function sessionById(id: string): SshSession | null {
  return sessions.get(id) ?? null;
}

export function writeSession(session: SshSession): void {
  sessions.set(session.id, session);
  publish();
}

export function patchSession(id: string, patch: Partial<Omit<SshSession, 'id'>>): void {
  const current = sessions.get(id);
  if (!current) {
    return;
  }
  sessions.set(id, { ...current, ...patch });
  publish();
}

export function dropSession(id: string): void {
  if (sessions.delete(id)) {
    publish();
  }
}

function publish(): void {
  snapshot = [...sessions.values()];
  for (const listener of listeners) {
    listener();
  }
}
