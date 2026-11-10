'use client';

import { Toaster } from '@/components/ui/sonner';
import { ConfirmProvider } from '@/components/ui/confirm';
import { TRPCContext } from '@/lib/trpc/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { SessionProvider } from 'next-auth/react';
import type { PropsWithChildren } from 'react';
import { useState } from 'react';
import { SignInHintEmailSyncer } from '@/components/auth/SignInHintEmailSyncer';
import { stepUpRequirementFromError } from '@/components/admin/step-up/step-up-error';
import { AdminStepUpRoot } from '@/components/admin/step-up/AdminStepUpRoot';

export function Providers({
  children,
  stepUpEnabled = false,
}: PropsWithChildren<{ stepUpEnabled?: boolean }>) {
  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 60 * 1000, // 1 minute
            // Step-up refusals are handled by the tRPC link/dialog. Retrying
            // one here would re-open the dialog after the user cancelled.
            retry: (failureCount, error) =>
              stepUpRequirementFromError(error) === null && failureCount < 1,
          },
        },
      })
  );

  return (
    <>
      <QueryClientProvider client={queryClient}>
        <TRPCContext>
          <SessionProvider>
            <AdminStepUpRoot enabled={stepUpEnabled}>
              <SignInHintEmailSyncer />
              <ConfirmProvider>{children}</ConfirmProvider>
            </AdminStepUpRoot>
          </SessionProvider>
        </TRPCContext>
      </QueryClientProvider>

      <Toaster />
    </>
  );
}
