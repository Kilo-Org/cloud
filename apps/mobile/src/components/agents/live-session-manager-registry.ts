import { type JotaiStore, type SessionManager } from '@kilocode/cloud-agent-sdk';

/**
 * Registry of the session manager that owns the open agent-chat screen, keyed
 * by kilo session id.
 *
 * The cloud-agent relay allows one owner per remote session, so a wrist
 * approval must answer through the connection the open screen already holds
 * instead of attaching a second one. `AgentSessionProvider` registers its
 * manager here while the chat screen is mounted; the front-approval
 * orchestrator reuses it when present and only creates a headless manager when
 * the session is not open.
 *
 * The `store` travels with the manager because the manager's atoms are only
 * readable through the jotai store it writes into.
 */
export type LiveSessionManagerHandle = {
  manager: SessionManager;
  store: JotaiStore;
};

const liveManagers = new Map<string, LiveSessionManagerHandle>();

/** Register the open screen's manager for a session. Unmount must unregister it. */
export function registerLiveSessionManager(
  sessionId: string,
  handle: LiveSessionManagerHandle
): void {
  liveManagers.set(sessionId, handle);
}

/**
 * Drop the registration for a session, but only while it still points at this
 * handle: a replacement provider that registered a newer manager for the same
 * session keeps its registration when the older one unmounts.
 */
export function unregisterLiveSessionManager(
  sessionId: string,
  handle: LiveSessionManagerHandle
): void {
  if (liveManagers.get(sessionId) === handle) {
    liveManagers.delete(sessionId);
  }
}

/** The open screen's manager for a session, or null when that session is not open. */
export function getLiveSessionManager(sessionId: string): LiveSessionManagerHandle | null {
  return liveManagers.get(sessionId) ?? null;
}
