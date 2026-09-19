import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { PortalHost } from '@rn-primitives/portal';
import { QueryClientProvider } from '@tanstack/react-query';
import { CheckCircle2, Info, Loader, TriangleAlert, XCircle } from '@/components/ui/icons';
import { type ReactNode, useEffect, useState } from 'react';
import { Keyboard } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
import { ToolSummaryTranslationRuntimeBootstrap } from '@/lib/tool-summary-translation/tool-summary-translation-preference';
import { trpcClient, TRPCProvider } from '@/lib/trpc';

/**
 * sonner-native's container for bottom-center toasts is `position: absolute`
 * with no height, and every toast is one of its children positioned with
 * `bottom: 0`: each child sits entirely outside the container's bounds. Android
 * still paints it (the container does not clip), but
 * `View.isVisibleToUser()` intersects a child's rect with its parent's — an
 * empty intersection drops the whole toast from the accessibility tree. The
 * toast is then on screen and silent: TalkBack reads nothing, and a
 * `uiautomator dump` shows no toast at all, which is how the device harness
 * lost the "Link copied" confirmation.
 *
 * Anchoring the container to the top of the window gives every toast a rect
 * inside its parent without moving it — the toast still positions itself
 * against the container's `bottom` inset. `positionerStyle` is merged after
 * sonner's own container style and its safe-area insets, and `top` is the one
 * edge the container never sets for bottom-center toasts.
 */
const TOAST_POSITIONER_STYLE = { top: 0 } as const;

function useToastKeyboardOffset() {
  const { bottom } = useSafeAreaInsets();
  const [keyboardHeight, setKeyboardHeight] = useState(() => Keyboard.metrics()?.height ?? 0);

  useEffect(() => {
    // One listener pair for both platforms: `keyboardDidShow`/`keyboardDidHide`
    // are the events Android and iOS share — Android has no native
    // `keyboardWillShow`/`keyboardWillHide`, and `Keyboard.metrics()` is filled
    // from the same JS events on both. Nothing here needs a platform branch.
    const show = Keyboard.addListener('keyboardDidShow', event => {
      setKeyboardHeight(event.endCoordinates.height);
    });
    const hide = Keyboard.addListener('keyboardDidHide', () => {
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  // The toast window never resizes for the IME on either platform: Android's
  // edge-to-edge window keeps its full height, and iOS renders the toaster
  // inside a `FullWindowOverlay` window above the app. The keyboard therefore
  // covers a bottom-center toast on both, clipping its lower corners and
  // padding. RN excludes the navigation bar from Android's reported IME height
  // but includes the home-indicator area on iOS, so adding the safe-area bottom
  // inset restores Android's navigation bar and only widens the gap on iOS.
  // With no IME, `undefined` leaves sonner's own safe-area placement untouched.
  return keyboardHeight > 0 ? keyboardHeight + bottom + 8 : undefined;
}

export function AppRootProviders({
  children,
  languageReady,
}: {
  readonly children: ReactNode;
  readonly languageReady: boolean;
}) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const toastOffset = useToastKeyboardOffset();

  return (
    // bg-background: the gesture root is the first opaque surface above the
    // window — a rotation relayout gap behind any screen must show the app's
    // own background, never the platform window default (foreign white/black).
    <GestureHandlerRootView className="flex-1 bg-background">
      <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
        <QueryClientProvider client={queryClient}>
          <QueryClientNativeLifecycle />
          <AuthProvider>
            <AppUnlockProvider
              promptMessage={languageReady ? t('preferences.biometricUnlock') : null}
            >
              {languageReady ? <AppUnlockAnnouncements /> : null}
              <OrganizationProvider>
                <ToolSummaryTranslationRuntimeBootstrap />
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
                      bottom-center: sonner-native's default top-center placement renders a toast
                      over the screen header, hiding the back control for the toast's whole
                      lifetime (spot check e4-end). Bottom is the transient-message convention:
                      a toast may cover the composer briefly, never the navigation.
                    */}
                    <Toaster
                      position="bottom-center"
                      offset={toastOffset}
                      positionerStyle={TOAST_POSITIONER_STYLE}
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
