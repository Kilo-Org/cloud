import { createContext, useContext } from 'react';
import { type SessionManager } from '@kilocode/cloud-agent-sdk';

/**
 * The live session manager, published by `SessionDetailContent` around the
 * transcript it renders. It lives in its own module — not in `session-provider`
 * — so a component that only reads it does not import the provider chain
 * (expo-router, the transport, the encrypted store), which the node-environment
 * test projects cannot load.
 *
 * The value is `null` outside the session screen, so a reader falls back to the
 * data it was handed instead of throwing.
 */
export const SessionManagerContext = createContext<SessionManager | null>(null);

/** The session manager, or `null` outside `SessionDetailContent`. Never throws. */
export function useOptionalSessionManager(): SessionManager | null {
  return useContext(SessionManagerContext);
}
