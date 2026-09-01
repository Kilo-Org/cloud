import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { PortalHost } from '@rn-primitives/portal';
import { QueryClientProvider } from '@tanstack/react-query';
import { CheckCircle2, Info, Loader, TriangleAlert, XCircle } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { Toaster } from 'sonner-native';
import { useTranslation } from 'react-i18next';

import { AppUnlockAnnouncements } from '@/components/app-unlock-screen';
import { OfflineBanner } from '@/components/offline-banner';
import { AppUnlockProvider } from '@/lib/app-unlock-context';
import { AuthProvider } from '@/lib/auth/auth-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { OrganizationProvider } from '@/lib/organization-context';
import { queryClient } from '@/lib/query-client';
import { QueryClientNativeLifecycle } from '@/lib/query-client-lifecycle';
import { trpcClient, TRPCProvider } from '@/lib/trpc';

export function AppRootProviders({
  children,
  languageReady,
}: {
  readonly children: ReactNode;
  readonly languageReady: boolean;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();

  return (
    <GestureHandlerRootView className="flex-1">
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <QueryClientNativeLifecycle />
          <AuthProvider>
            <AppUnlockProvider
              promptMessage={languageReady ? t('preferences.biometricUnlock') : null}
            >
              {languageReady ? <AppUnlockAnnouncements /> : null}
              <OrganizationProvider>
                <ActionSheetProvider>
                  <>
                    {children}
                    <OfflineBanner />
                    <PortalHost />
                    {/*
                      Toaster mounts last so it renders above PortalHost overlays (sheets/dropdowns
                      built on @rn-primitives/portal) — last sibling wins for overlapping overlays.
                      Ground truth (D2): prior on-device testing (2026-07-07, iOS) found sonner-native
                      toasts render BEHIND Expo formSheets despite FullWindowOverlay; this reordering
                      addresses Portal overlays only — sheets/modals still need inline errors (P2);
                      re-verification scheduled in the final device pass.
                    */}
                    <Toaster
                      icons={{
                        success: <CheckCircle2 size={20} color={colors.good} />,
                        error: <XCircle size={20} color={colors.destructive} />,
                        warning: <TriangleAlert size={20} color={colors.warn} />,
                        info: <Info size={20} color={colors.mutedForeground} />,
                        loading: <Loader size={20} color={colors.mutedForeground} />,
                      }}
                      toastOptions={{
                        style: {
                          backgroundColor: colors.card,
                          borderColor: colors.border,
                          borderWidth: 1,
                        },
                        titleStyle: { color: colors.foreground },
                        descriptionStyle: { color: colors.mutedForeground },
                      }}
                    />
                  </>
                </ActionSheetProvider>
              </OrganizationProvider>
            </AppUnlockProvider>
          </AuthProvider>
        </QueryClientProvider>
      </TRPCProvider>
    </GestureHandlerRootView>
  );
}
