'use client';

import { createContext, use, type ReactNode } from 'react';

/**
 * Context that tells claw components whether they're running in an
 * org context. When organizationId is set, dispatcher hooks route to
 * trpc.organizations.kiloclaw.* instead of trpc.kiloclaw.*.
 */
type ClawContextValue = {
  organizationId: string | undefined;
};

const ClawCtx = createContext<ClawContextValue>({ organizationId: undefined });

export function ClawContextProvider({
  organizationId,
  children,
}: {
  organizationId: string | undefined;
  children: ReactNode;
}) {
  return <ClawCtx value={{ organizationId }}>{children}</ClawCtx>;
}

export function useClawContext(): ClawContextValue {
  return use(ClawCtx);
}
