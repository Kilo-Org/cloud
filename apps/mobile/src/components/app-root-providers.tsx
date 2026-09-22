import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { PortalHost } from '@rn-primitives/portal';
import { QueryClientProvider } from '@tanstack/react-query';
import { usePathname, useSegments } from 'expo-router';
import { CheckCircle2, Info, Loader, TriangleAlert, XCircle } from '@/components/ui/icons';
import { type ReactNode } from 'react';
import { Platform, useWindowDimensions } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Toaster } from 'sonner-native';
import { useTranslation } from 'react-i18next';

import { AppUnlockAnnouncements } from '@/components/app-unlock-screen';
import { useAppAwareKeyboardPadding } from '@/components/kilo-chat/app-aware-keyboard-padding';
import { resolveKeyboardBottomPadding } from '@/components/login-screen-state';
import { OfflineBanner } from '@/components/offline-banner';
import { AppUnlockProvider } from '@/lib/app-unlock-context';
import { AuthProvider } from '@/lib/auth/auth-context';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { OrganizationProvider } from '@/lib/organization-context';
import { queryClient } from '@/lib/query-client';
import { QueryClientNativeLifecycle } from '@/lib/query-client-lifecycle';
import { ToolSummaryTranslationRuntimeBootstrap } from '@/lib/tool-summary-translation/tool-summary-translation-preference';
import { getEffectiveTabBarHeight, shouldHideTabBar } from '@/lib/tab-bar-layout';
import { getToastBottomOffset } from '@/lib/toast-offset';
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

export function AppRootProviders({
  children,
  languageReady,
}: {
  readonly children: ReactNode;
  readonly languageReady: boolean;
}) {
  const { t } = useTranslation();

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
                    <AppToaster />
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

/**
 * The Toaster reads the keyboard through the shared
 * `useAppAwareKeyboardPadding` hook, so its height cannot drift from the one
 * the screens reserve. It is called here, in a child of `AppRootProviders`,
 * so a keyboard show/hide re-renders only the Toaster, never the app tree the
 * provider wraps.
 *
 * Android needs this even though the app is edge-to-edge: under API 35+ the
 * window never resizes for the IME (`login-screen.tsx`), and
 * `react-native-safe-area-context` does not report IME insets, so a
 * bottom-anchored overlay has no other way to clear the keyboard and its
 * navigation row.
 *
 * The offset is one platform-free rule (`lib/toast-offset.ts`): iOS and Android
 * run the same math, and the platform enters only through the values resolved
 * here for it — the tab bar's own rendered height, which the bar's helper owns,
 * and the keyboard occlusion's origin (`resolveKeyboardBottomPadding`).
 */
function AppToaster() {
  const colors = useThemeColors();
  const { bottom } = useSafeAreaInsets();
  const { fontScale } = useWindowDimensions();
  const keyboardHeight = useAppAwareKeyboardPadding();
  // The hook's height is the platform's own keyboard metric, and the two
  // platforms measure it from different origins: Android's stops at the
  // navigation bar (`ReactRootView` reports `imeInsets.bottom − barInsets.bottom`),
  // while iOS reports the keyboard frame, which reaches the screen bottom. The
  // offset is anchored to the screen bottom, so the occlusion is resolved here
  // with the same rule the screens reserve padding with
  // (`resolveKeyboardBottomPadding`); passing the raw Android height left the
  // toast's last line behind the IME's navigation row (2026-09-20 review
  // finding). `lib/toast-offset.ts` stays platform-free.
  const keyboardOcclusion =
    keyboardHeight > 0
      ? resolveKeyboardBottomPadding({ keyboardHeight, bottomInset: bottom, platform: Platform.OS })
      : 0;
  const segments = useSegments();
  const pathname = usePathname();
  // The floating tab bar is an absolute overlay over the screen bottom, so it
  // never appears in the reported bottom inset and a toast anchored to the
  // inset landed over the tab icons (2026-09-19 visual spot check, p1). It
  // renders exactly when the focused route sits inside the tabs navigator and
  // `shouldHideTabBar` does not hide it — the same predicate the bar's own
  // layout uses — so the toast clears it only while it is actually on screen;
  // a screen pushed over the tabs (agent-chat, pr-review) or the auth flow
  // keeps the toast at its resting offset. `getEffectiveTabBarHeight` is the
  // bar's own measurement (it carries the bar's small Android-only extra
  // padding), so the toast cannot disagree with what the bar renders. See
  // `lib/toast-offset.ts`.
  const tabBarHeight =
    (segments as readonly string[]).includes('(tabs)') && !shouldHideTabBar(pathname)
      ? getEffectiveTabBarHeight({ bottomInset: bottom, platform: Platform.OS, fontScale })
      : 0;

  return (
    <Toaster
      position="bottom-center"
      // Explicit offset, rather than sonner-native's `safe area inset + 8`:
      // the reported inset can under-report the bottom chrome (Android's IME
      // navigation row), which left the error toast's last line clipped under
      // it, and never covers the floating tab bar, which the toast then
      // covered. One platform-free rule; see `lib/toast-offset.ts`.
      offset={getToastBottomOffset({
        safeAreaBottom: bottom,
        keyboardHeight: keyboardOcclusion,
        tabBarHeight,
      })}
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
  );
}
