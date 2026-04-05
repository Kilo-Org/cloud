'use client';

import { createContext, useContext } from 'react';

type LockableContainerContextType = {
  isLocked: boolean;
  tooltipWhenLocked?: string;
};

const LockableContainerContext = createContext<LockableContainerContextType>({
  isLocked: false,
  tooltipWhenLocked: undefined,
});

/**
 * Hook to access lockable container context
 * Returns false if not within a lockable context (backward compatible)
 */
export function useLockableContainerContext(): LockableContainerContextType {
  return useContext(LockableContainerContext);
}

export const LockableContainerProvider = LockableContainerContext.Provider;
