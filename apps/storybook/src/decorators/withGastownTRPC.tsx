import React, { useState, type ReactNode } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import type { Decorator } from '@storybook/nextjs';
import { GastownTRPCProvider, createGastownTRPCClient } from '@/lib/gastown/trpc';

// Provides the Gastown worker tRPC context so components that call
// `useGastownTRPC()` render in isolation. The client has no working token
// endpoint in Storybook, so stories must avoid triggering network requests
// (render shells / open states only; mutations fire on interaction).
function GastownProviders({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const [trpcClient] = useState(() => createGastownTRPCClient());
  return (
    <GastownTRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
      {children}
    </GastownTRPCProvider>
  );
}

export const withGastownTRPC: Decorator = Story => (
  <GastownProviders>
    <Story />
  </GastownProviders>
);
