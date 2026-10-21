/* eslint-disable max-lines -- The login screen keeps its device-auth branches, keyboard padding, and language picker together. */
import * as Clipboard from 'expo-clipboard';
import { type Href, useRouter } from 'expo-router';
import { Globe } from '@/components/ui/icons';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  I18nManager,
  type LayoutChangeEvent,
  PixelRatio,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View,
} from 'react-native';
import { useKeyboardState } from 'react-native-keyboard-controller';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { toast } from 'sonner-native';

import logo from '@/../assets/images/logo.png';
import { BootstrapLoadingSurface } from '@/components/bootstrap-loading-surface';
import { CenteredState } from '@/components/centered-state';
import { IdleAuth } from '@/components/login/idle-auth';
import { errorMessage, resolveKeyboardBottomPadding } from '@/components/login-screen-state';
import { Button } from '@/components/ui/button';
import { Image } from '@/components/ui/image';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useAuth } from '@/lib/auth/auth-context';
import { useDeviceAuth } from '@/lib/auth/use-device-auth';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { getCenteredStateLayout, isShortViewport } from '@/lib/centered-state-layout';
import {
  clearLoginDrafts,
  clearPersistedLoginDrafts,
  persistLoginDrafts,
  restoreLoginDrafts,
  type SsoRecoveryDraft,
} from '@/lib/login-draft';
import { setLanguagePickerBridge } from '@/lib/picker-bridge';
import { useScreenInsets } from '@/lib/screen-insets';

export function LoginScreen() {
  const { sessionEnded, signIn } = useAuth();
  const router = useRouter();
  const {
    status,
    token,
    code,
    refreshToken,
    expiresIn,
    error,
    verificationUrl,
    resumed,
    start,
    cancel,
    openBrowser,
    clearError,
  } = useDeviceAuth();
  const colors = useThemeColors();
  const insets = useScreenInsets();
  const windowSize = useWindowDimensions();
  const { t } = useTranslation();
  // The `KeyboardProvider` at the root measures the keyboard once in native
  // code, so this screen reads the height instead of listening to React Native's
  // keyboard events. The provider also clears the height when the app leaves the
  // foreground, which the listener pair used to do itself.
  const keyboardHeight = useKeyboardState(state => state.height);
  const [persistFailed, setPersistFailed] = useState(false);
  const [authFormBusy, setAuthFormBusy] = useState(false);
  const [draft, setDraft] = useState<{
    email: string;
    ssoRecovery: SsoRecoveryDraft | null;
  } | null>(null);

  // The form centers in the viewport while it fits and top-anchors when it
  // does not (a landscape window at a large text size): centered overflow
  // clips the stack at both edges, hiding the code screen's heading above the
  // top and the primary button below the bottom. The measured layout follows
  // the same helper the centered states use (`centered-state-layout.ts`), so
  // the geometry rules stay in one place. The viewport is the ScrollView's own
  // frame, which already excludes the wrapper's keyboard and bottom-chrome
  // reservation.
  const scrollRef = useRef<ScrollView | null>(null);
  const measureRequestRef = useRef(0);
  const [viewportFrame, setViewportFrame] = useState<{ top: number; bottom: number } | null>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);

  const measureViewport = useCallback(() => {
    measureRequestRef.current += 1;
    const request = measureRequestRef.current;
    // Same ref contract as `CenteredState`: the harness's host element has no
    // native scroll ref, so the measured layout stays pending there and the
    // fallback centered geometry applies.
    const node = scrollRef.current?.getNativeScrollRef() ?? null;
    if (!node) {
      setViewportFrame(null);
      return;
    }
    node.measureInWindow((...bounds) => {
      const [, top, , height] = bounds;
      if (request !== measureRequestRef.current) {
        return;
      }
      const bottom = top + height;
      if (height <= 0 || !Number.isFinite(top) || !Number.isFinite(bottom)) {
        setViewportFrame(null);
        return;
      }
      setViewportFrame(previous =>
        previous?.top === top && previous.bottom === bottom ? previous : { top, bottom }
      );
    });
  }, []);

  const captureScroll = useCallback(
    (node: ScrollView | null) => {
      scrollRef.current = node;
      measureViewport();
    },
    [measureViewport]
  );

  useLayoutEffect(() => {
    measureViewport();
    return () => {
      measureRequestRef.current += 1;
    };
  }, [measureViewport, windowSize.width, windowSize.height, keyboardHeight]);

  const handleContentLayout = useCallback((event: LayoutChangeEvent) => {
    setContentHeight(PixelRatio.roundToNearestPixel(event.nativeEvent.layout.height));
  }, []);

  // A phone held sideways cannot fit the full stack, so the welcome block
  // (logo + greeting) drops there and the form alone fills the viewport.
  // The measured layout still centers whatever remains.
  const shortBand = isShortViewport(windowSize.width, windowSize.height);

  const contentLayout = useMemo(() => {
    if (viewportFrame === null || contentHeight === null) {
      return undefined;
    }
    return getCenteredStateLayout({
      surface: viewportFrame,
      viewport: viewportFrame,
      contentHeight,
      // The overflow path anchors at the band's top; without the inset the
      // first row would start under a notch or status bar overlay.
      topInset: insets.top,
      roundToPixel: value => PixelRatio.roundToNearestPixel(value),
    });
  }, [viewportFrame, contentHeight, insets.top]);

  // While the first measurement is pending keep the previous centered
  // geometry: the common portrait case never overflows, and the measured
  // layout replaces this on the next frame.
  const pendingContentStyle = { flexGrow: 1, justifyContent: 'center' as const };
  const measuredContentStyle = useMemo(
    () =>
      contentLayout && {
        flexGrow: 1,
        minHeight: contentLayout.minHeight,
        paddingTop: contentLayout.paddingTop,
        paddingBottom: contentLayout.paddingBottom,
      },
    [contentLayout]
  );

  const persistToken = useCallback(
    async (tokenValue: string, refreshTokenValue?: string, expiresInValue?: number) => {
      setPersistFailed(false);
      try {
        await signIn(tokenValue, refreshTokenValue, expiresInValue);
        clearLoginDrafts();
      } catch {
        // The message renders from the catalog at draw time, so a language
        // switch re-renders it in the new language.
        setPersistFailed(true);
      }
    },
    [signIn]
  );

  useEffect(() => {
    let cancelled = false;
    const restoreDrafts = async () => {
      try {
        const restored = await restoreLoginDrafts();
        if (!cancelled) {
          setDraft(restored);
          void clearPersistedLoginDrafts();
        }
      } catch {
        if (!cancelled) {
          setDraft({ email: '', ssoRecovery: null });
        }
      }
    };
    void restoreDrafts();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (sessionEnded) {
      // id dedupes the toast if the login route remounts while still signed out
      announcingToast.warning(t('login.sessionEnded'), { id: 'session-ended' });
    }
  }, [sessionEnded, t]);

  useEffect(() => {
    if (status === 'approved' && token) {
      void persistToken(token, refreshToken, expiresIn);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps -- persistToken is stable except for signIn identity; only re-run on a newly approved token
  }, [status, token]);

  if (status === 'approved') {
    if (persistFailed) {
      return (
        <CenteredState className="bg-background">
          <View className="items-center gap-3 px-6">
            <Text className="text-center text-sm text-destructive">
              {t('login.couldNotCompleteSignIn')}
            </Text>
            <Button
              onPress={() => {
                if (token) {
                  void persistToken(token, refreshToken, expiresIn);
                }
              }}
              accessibilityLabel={t('login.retrySignIn')}
            >
              <Text>{t('common.retry')}</Text>
            </Button>
          </View>
        </CenteredState>
      );
    }
    // The approved hold: the device authorized, and the token write plus the
    // root layout's redirect are still in flight. Reuse the one branded wait
    // surface — a bare spinner on an empty background read as an unbranded
    // blank page (explorer signin-language).
    return <BootstrapLoadingSurface />;
  }

  // One padded wrapper for both platforms: the bottom inset is reserved at
  // rest, and while the IME is up the provider's keyboard height is reserved
  // instead (see `resolveKeyboardBottomPadding`). The ScrollView's measured
  // content container re-centres (or top-anchors) in the space that stays
  // above the keyboard, so "Continue" is never left under the keyboard, the
  // navigation bar, or the home indicator.
  const bottomPadding = resolveKeyboardBottomPadding({
    keyboardHeight,
    bottomInset: insets.bottom,
  });
  // The Globe stays enabled on idle, denied, expired, and error (those render
  // an interactive IdleAuth form); it is disabled while a device-auth flow
  // (pending/approved) or a busy auth action owns the screen.
  const globeDisabled = status === 'pending' || authFormBusy;
  const globeTrailing = I18nManager.isRTL
    ? { left: insets.left + 16 }
    : { right: insets.right + 16 };
  // A terminal device-auth error — an expired code, denied access, or the poll
  // timing out — renders its message above the idle form. Idle, every terminal
  // error, and a start that has not answered yet share the same single IdleAuth
  // slot below, so dismissing the error when a new attempt starts preserves the
  // form's in-flight state.
  // A start that has not answered yet (`pending` with no code yet) keeps the
  // idle form on screen too: beginning a new attempt dismisses the old error,
  // and the form stays in place while the attempt runs, with the starting
  // indicator below instead of a wholesale swap to the spinner.
  const startInFlight = status === 'pending' && !code;
  const showTerminalError = status === 'denied' || status === 'expired' || status === 'error';
  const showIdleForm = status === 'idle' ? draft !== null : showTerminalError || startInFlight;

  return (
    // One wrapper owns the vertical space on both platforms: it paints the
    // screen background and reserves the bottom padding resolved above, so the
    // ScrollView's centered form stays above the keyboard, the navigation bar,
    // and the home indicator.
    <View
      className="flex-1 bg-background"
      // eslint-disable-next-line react-native/no-inline-styles -- dynamic keyboard and safe-area padding
      style={{
        paddingBottom: bottomPadding,
        paddingLeft: insets.left,
        paddingRight: insets.right,
      }}
    >
      <ScrollView
        ref={captureScroll}
        className="flex-1 bg-background"
        onLayout={measureViewport}
        // No `contentContainerClassName`: setting `contentContainerStyle`
        // makes NativeWind drop the caller's class (see `tab-screen.tsx`), so
        // the gutter padding and centering live on the measured wrapper.
        contentContainerStyle={measuredContentStyle ?? pendingContentStyle}
        keyboardShouldPersistTaps="handled"
      >
        {/* Branch fade animations parked mid-flight on remount — e1 measured 2/2
            iOS logout→login remounts washed out at ~50% alpha for 3+ minutes,
            recovering only on relaunch — so these branches render without
            animation; status swaps are instant. */}
        {/* One measured wrapper around the whole stack (welcome block + auth
            branches): its height decides whether the form centers or
            top-anchors. The wrapper carries the gutter padding, the centered
            column, and the `gap-6` rhythm the content container carried
            before. */}
        <View className="mx-auto w-full max-w-sm gap-6 px-6" onLayout={handleContentLayout}>
          {shortBand ? null : (
            <View className="w-full items-center gap-2">
              <Image
                source={logo}
                className="mb-1 h-16 w-16"
                accessibilityLabel={t('login.logo')}
              />
              <Text className="text-center text-lg">{t('login.welcome')}</Text>
            </View>
          )}
          <View className="w-full gap-3">
            {/* A terminal device-auth error keeps the idle form on screen so the
                user can retry. The banner is a sibling above one IdleAuth at one
                JSX slot, so clearing the error when a new attempt starts does not
                remount the form and lose an in-flight OTP challenge. */}
            {showTerminalError && (
              <Text className="text-center text-sm text-destructive">
                {errorMessage(status, error)}
              </Text>
            )}

            {status === 'idle' && draft === null && (
              <>
                {/* Form-sized placeholder until the SecureStore draft restore finishes. */}
                <Skeleton className="h-16 w-full" />
                <Skeleton className="h-11 w-full" />
              </>
            )}

            {showIdleForm && (
              <IdleAuth
                start={start}
                initialEmail={draft?.email ?? ''}
                initialSsoRecovery={draft?.ssoRecovery ?? null}
                onBusyChange={setAuthFormBusy}
                onSignInStart={clearError}
              />
            )}

            {status === 'pending' && code && (
              <View className="w-full items-center gap-4">
                {resumed && (
                  <Text variant="muted" className="text-center">
                    {t('login.continuingSignIn')}
                  </Text>
                )}
                <Text variant="muted" className="text-center">
                  {t('login.signInCode')}
                </Text>
                <Text
                  variant="h2"
                  className="border-b-0 pb-0 text-center tracking-widest"
                  accessibilityLabel={t('login.signInCodeAccessibility', {
                    // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code is always ASCII
                    code: [...code].join(' '),
                  })}
                  selectable
                >
                  {code}
                </Text>
                {/* Stack actions full-width so labels never clip side-by-side at max text */}
                <View className="w-full gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onPress={() => {
                      void openBrowser();
                    }}
                    accessibilityLabel={t('login.openSignInPageInBrowser')}
                  >
                    <Text className="text-center">{t('common.openInBrowser')}</Text>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onPress={() => {
                      if (verificationUrl) {
                        void Clipboard.setStringAsync(verificationUrl);
                        toast(t('common.copiedToClipboard'));
                      }
                    }}
                    accessibilityLabel={t('login.copySignInLink')}
                  >
                    <Text className="text-center">{t('common.copyLink')}</Text>
                  </Button>
                </View>
                <Button
                  variant="ghost"
                  onPress={cancel}
                  accessibilityLabel={t('login.cancelSignIn')}
                >
                  <Text>{t('common.cancel')}</Text>
                </Button>
              </View>
            )}

            {status === 'pending' && !code && (
              <View className="w-full items-center gap-3">
                <ActivityIndicator size="small" color={colors.mutedForeground} />
                <Text variant="muted" className="text-center">
                  {t('login.startingSignIn')}
                </Text>
                <Button
                  variant="ghost"
                  onPress={cancel}
                  accessibilityLabel={t('login.cancelSignIn')}
                >
                  <Text>{t('common.cancel')}</Text>
                </Button>
              </View>
            )}
          </View>
        </View>
      </ScrollView>
      <Pressable
        onPress={() => {
          setLanguagePickerBridge({ beforeReload: persistLoginDrafts });
          router.push('/(auth)/language-picker' as Href);
        }}
        disabled={globeDisabled}
        hitSlop={8}
        accessibilityRole="button"
        accessibilityLabel={t('common.language')}
        accessibilityState={{ disabled: globeDisabled }}
        className="absolute h-11 w-11 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
        // eslint-disable-next-line react-native/no-inline-styles -- safe-area + RTL-aware trailing edge
        style={{ top: insets.top + 8, ...globeTrailing }}
      >
        <Globe size={22} color={colors.foreground} />
      </Pressable>
    </View>
  );
}
