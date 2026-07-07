import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { PortalHost } from '@rn-primitives/portal';
import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Toaster } from 'sonner-native';

import { AuthProvider } from '@/lib/auth/auth-context';
import { OrganizationProvider } from '@/lib/organization-context';
import { queryClient } from '@/lib/query-client';
import { QueryClientNativeLifecycle } from '@/lib/query-client-lifecycle';
import { trpcClient, TRPCProvider } from '@/lib/trpc';

export function AppRootProviders({ children }: { readonly children: ReactNode }) {
  return (
    <GestureHandlerRootView className="flex-1">
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <QueryClientNativeLifecycle />
          <AuthProvider>
            <OrganizationProvider>
              <ActionSheetProvider>
                <>
                  {children}
                  <Toaster />
                  <PortalHost />
                </>
              </ActionSheetProvider>
            </OrganizationProvider>
          </AuthProvider>
        </QueryClientProvider>
      </TRPCProvider>
    </GestureHandlerRootView>
  );
}
