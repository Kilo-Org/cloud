/**
 * Cloud Agent Provider
 *
 * Provides a scoped Jotai store for cloud agent chat state.
 * Each instance creates an isolated store for the chat session.
 *
 * This kinda follows CLI's pattern of explicit store creation rather.
 */

'use client';

import { Provider as JotaiProvider, createStore } from 'jotai';
import { useRef, type ReactNode } from 'react';

interface CloudAgentProviderProps {
  children: ReactNode;
}

export function CloudAgentProvider({ children }: CloudAgentProviderProps) {
  // Create store once per provider instance
  // useRef ensures the store survives re-renders but is created only once
  const storeRef = useRef(createStore());

  return <JotaiProvider store={storeRef.current}>{children}</JotaiProvider>;
}
