import { ActionSheetProvider } from '@expo/react-native-action-sheet';
import { PortalHost } from '@rn-primitives/portal';
import { QueryClientProvider } from '@tanstack/react-query';
import { type ReactNode } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { useTranslation } from 'react-i18next';

import { AppToaster } from '@/components/app-toaster';
import { AppUnlockAnnouncements } from '@/components/app-unlock-screen';
import { DeviceLanguageFollow } from '@/components/device-language-follow';
import { OfflineBanner } from '@/components/offline-banner';
import { SheetTouchGuard } from '@/components/sheet-touch-guard';
import { KeyboardMotionProvider } from '@/components/keyboard-motion-provider';
import { AppUnlockProvider } from '@/lib/app-unlock-context';
import { SystemFontScaleProvider } from '@/lib/font-scale/system-font-scale';
import { AuthProvider } from '@/lib/auth/auth-context';
import { OrganizationProvider } from '@/lib/organization-context';
import { queryClient } from '@/lib/query-client';
import { QueryClientNativeLifecycle } from '@/lib/query-client-lifecycle';
import { ToolSummaryTranslationRuntimeBootstrap } from '@/lib/tool-summary-translation/tool-summary-translation-preference';
import { useModalSurfacePresented } from '@/lib/modal-surface-veil';
import { trpcClient, TRPCProvider } from '@/lib/trpc';

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
    <SystemFontScaleProvider>
      <GestureHandlerRootView className="flex-1 bg-background">
        {/* `react-native-keyboard-controller` measures the keyboard once in native
          code and hands the height and the insets to every consumer. The app's
          keyboard surfaces — `KeyboardAvoidingView` on the session, quick-chat
          and detail screens, and the shared owned-keyboard lift on the Agents
          list and history — read it from here instead of listening to React
          Native's keyboard events. */}
        <KeyboardMotionProvider>
          <TRPCProvider trpcClient={trpcClient} queryClient={queryClient}>
            <QueryClientProvider client={queryClient}>
              <QueryClientNativeLifecycle />
              <DeviceLanguageFollow enabled={languageReady} />
              <AuthProvider>
                <AppUnlockProvider
                  promptMessage={languageReady ? t('preferences.biometricUnlock') : null}
                >
                  {languageReady ? <AppUnlockAnnouncements /> : null}
                  <OrganizationProvider>
                    <ToolSummaryTranslationRuntimeBootstrap />
                    {/* Use one renderer so iOS and Android both honor the app palette and safe area. */}
                    <ActionSheetProvider useCustomActionSheet>
                      <>
                        <AppCoveredContent>{children}</AppCoveredContent>
                        {/*
                        Toaster mounts last so it renders above PortalHost overlays (sheets/dropdowns
                        built on @rn-primitives/portal) — last sibling wins for overlapping overlays.
                        A native sheet covers this whole tree, so while one is open the sheet draws
                        the toasts itself (`SheetToaster`) and this one renders nothing.
                      */}
                        <AppToaster />
                      </>
                    </ActionSheetProvider>
                  </OrganizationProvider>
                </AppUnlockProvider>
              </AuthProvider>
            </QueryClientProvider>
          </TRPCProvider>
        </KeyboardMotionProvider>
      </GestureHandlerRootView>
    </SystemFontScaleProvider>
  );
}

/**
 * Everything a native sheet covers: the app tree, the offline banner and the
 * portal overlays. `SheetTouchGuard` claims a touch that starts before the
 * sheet's own window exists, the tab bar and those overlays included; see
 * `@/lib/sheet-touch-guard` for the window it covers.
 *
 * The navigator and the app chrome also take the modal veil while an in-tree
 * modal surface — a `DialogCard`, the session preview overlay — is open. Such a
 * surface renders into the `PortalHost` below, inside the app's own window, so
 * nothing else hides what it covers: on Android the covered screen stayed in the
 * accessibility tree, ahead of the dialog's own controls (measured with
 * `uiautomator dump --compressed`). The `PortalHost` stays outside the veiled
 * view, which leaves the dialog as the only reachable and tappable surface
 * while it is up. Native sheets are separate windows on Android, and on the
 * other platform they render their content inside the app tree, so they never
 * take this veil.
 */
function AppCoveredContent({ children }: Readonly<{ children: ReactNode }>) {
  const modalSurface = useModalSurfacePresented();
  return (
    <SheetTouchGuard>
      <View
        // Keep the native view: Android collapses Views whose only props are
        // styles, and a collapsed view drops its accessibility props, so the
        // hiding would silently no-op. The scene gate escapes it the same way.
        collapsable={false}
        accessibilityElementsHidden={modalSurface}
        importantForAccessibility={modalSurface ? 'no-hide-descendants' : 'auto'}
        pointerEvents={modalSurface ? 'none' : 'auto'}
        className="flex-1"
      >
        {children}
        <OfflineBanner />
      </View>
      <PortalHost />
    </SheetTouchGuard>
  );
}
