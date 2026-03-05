'use client';

import { Toaster } from '@/components/ui/sonner';
import { TRPCContext } from '@/lib/trpc/client';
import { GastownTRPCProvider, createGastownTRPCClient } from '@/lib/gastown/trpc';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import type { PropsWithChildren } from 'react';
import { useState } from 'react';
import { SignInHintEmailSyncer } from '@/components/auth/SignInHintEmailSyncer';

export function Providers({ children }: PropsWithChildren) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            retry: 1,
          },
        },
      })
  );
  const [gastownClient] = useState(() => createGastownTRPCClient());

  return (
    <>
      <QueryClientProvider client={queryClient}>
        <TRPCContext>
          <GastownTRPCProvider trpcClient={gastownClient} queryClient={queryClient}>
            <SessionProvider>
              <SignInHintEmailSyncer />
              {children}
            </SessionProvider>
          </GastownTRPCProvider>
        </TRPCContext>
      </QueryClientProvider>

      <Toaster />
    </>
  );
}
