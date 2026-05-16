'use client';

import { createContext, useContext, type ReactNode } from 'react';

/**
 * Context for the resolved owner/repo wasteland. Populated by the layout
 * once `wasteland.resolveOwnerRepo` returns. Children that need the
 * underlying `wastelandId` (to call existing UUID-keyed procedures) read
 * it from here instead of re-resolving.
 */
export type WastelandRepoIdentity = {
  owner: string;
  repo: string;
  wastelandId: string;
  ownerType: 'user' | 'org';
  ownerUserId: string | null;
  organizationId: string | null;
  name: string;
};

const WastelandRepoContext = createContext<WastelandRepoIdentity | null>(null);

export function WastelandRepoProvider({
  value,
  children,
}: {
  value: WastelandRepoIdentity;
  children: ReactNode;
}) {
  return <WastelandRepoContext.Provider value={value}>{children}</WastelandRepoContext.Provider>;
}

/** Read the resolved repo identity. Throws if used outside the provider. */
export function useWastelandRepo(): WastelandRepoIdentity {
  const value = useContext(WastelandRepoContext);
  if (!value) {
    throw new Error(
      'useWastelandRepo must be used inside a connected /wasteland/[owner]/[repo] subtree'
    );
  }
  return value;
}

/** Read the resolved repo identity, or null when the wasteland isn't connected. */
export function useOptionalWastelandRepo(): WastelandRepoIdentity | null {
  return useContext(WastelandRepoContext);
}
