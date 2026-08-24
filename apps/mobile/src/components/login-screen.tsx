/* eslint-disable max-lines -- The login screen keeps its device-auth branches, keyboard padding, and language picker together. */
import * as Clipboard from 'expo-clipboard';
import { ExternalLink, Globe } from '@/components/ui/icons';
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ActivityIndicator,
  AppState,
  I18nManager,
  Keyboard,
  KeyboardAvoidingView,
  type KeyboardEvent,
  Platform,
  Pressable,
  ScrollView,
  View,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import logo from '@/../assets/images/logo.png';
import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from '@/components/kilo-chat/app-aware-keyboard-padding-state';
import { IdleAuth } from '@/components/login/idle-auth';
import { errorMessage } from '@/components/login-screen-state';
import { LanguagePickerSheet } from '@/components/language-picker-sheet';
import { Button } from '@/components/ui/button';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { useAuth } from '@/lib/auth/auth-context';
import { useDeviceAuth } from '@/lib/auth/use-device-auth';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import {
  clearLoginDrafts,
  persistLoginDrafts,
  restoreLoginDrafts,
  type SsoRecoveryDraft,
} from '@/lib/login-draft';

function keyboardHeightFromEvent(event: KeyboardEvent): number {
  return event.endCoordinates.height;
}

export function LoginScreen() {
  const { sessionEnded, signIn } = useAuth();
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
  } = useDeviceAuth();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const { t } = useTranslation();
  const [persistError, setPersistError] = useState<string | undefined>(undefined);
  const [androidKeyboardHeight, setAndroidKeyboardHeight] = useState(0);
  const [languagePickerOpen, setLanguagePickerOpen] = useState(false);
  const [authFormBusy, setAuthFormBusy] = useState(false);
  const [draft, setDraft] = useState<{
    email: string;
    ssoRecovery: SsoRecoveryDraft | null;
  } | null>(null);

  const persistToken = useCallback(
    async (tokenValue: string, refreshTokenValue?: string, expiresInValue?: number) => {
      setPersistError(undefined);
      try {
        await signIn(tokenValue, refreshTokenValue, expiresInValue);
        clearLoginDrafts();
      } catch {
        setPersistError(t('login.couldNotCompleteSignIn'));
      }
    },
    [signIn, t]
  );

  useEffect(() => {
    let cancelled = false;
    const restoreDrafts = async () => {
      try {
        const restored = await restoreLoginDrafts();
        if (!cancelled) {
          setDraft(restored);
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

  // Android shell keyboard pad: under API 35+ EDGE_TO_EDGE_ENFORCED the window
  // never resizes for the IME, so KeyboardAvoidingView is inert. keyboardDidShow
  // still fires with real heights; consume them here (r0b: zero layout shift for
  // the email IME when only KAV was present).
  useEffect(() => {
    if (Platform.OS !== 'android') {
      return undefined;
    }

    const keyboardEvents = resolveKeyboardPaddingEventsForPlatform(Platform.OS);
    if (keyboardEvents === null) {
      setAndroidKeyboardHeight(0);
      return undefined;
    }

    const keyboardShowSubscription = Keyboard.addListener(keyboardEvents.show, event => {
      setAndroidKeyboardHeight(current =>
        resolveAppAwareKeyboardPadding({
          currentPadding: current,
          event: {
            type: 'keyboard-visible',
            keyboardHeight: keyboardHeightFromEvent(event),
          },
        })
      );
    });
    const keyboardHideSubscription = Keyboard.addListener(keyboardEvents.hide, () => {
      setAndroidKeyboardHeight(current =>
        resolveAppAwareKeyboardPadding({
          currentPadding: current,
          event: { type: 'keyboard-hidden' },
        })
      );
    });
    const appStateSubscription = AppState.addEventListener('change', appState => {
      setAndroidKeyboardHeight(current =>
        resolveAppAwareKeyboardPadding({
          currentPadding: current,
          event: { type: 'app-state-change', appState },
        })
      );
    });

    return () => {
      keyboardShowSubscription.remove();
      keyboardHideSubscription.remove();
      appStateSubscription.remove();
    };
  }, []);

  if (status === 'approved') {
    if (persistError) {
      return (
        <View className="flex-1 items-center justify-center gap-3 bg-background px-6">
          <Text className="text-center text-sm text-destructive">{persistError}</Text>
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
      );
    }
    return (
      <View className="flex-1 items-center justify-center bg-background">
        <ActivityIndicator color={colors.mutedForeground} />
      </View>
    );
  }

  // RN 0.86 Android (ReactRootView.java) reports endCoordinates.height =
  // imeInsets.bottom − barInsets.bottom (excludes the nav bar). endCoordinates.screenY
  // is NOT the IME top under adjustResize, so full occlusion is
  // endCoordinates.height + useSafeAreaInsets().bottom (= WindowInsets.ime().bottom;
  // verified 704px + 63px = 767px on pixel9). Pad only when the keyboard is up so
  // the resting layout is untouched.
  const androidKeyboardPad = androidKeyboardHeight > 0 ? androidKeyboardHeight + insets.bottom : 0;
  // The Globe stays enabled on idle, denied, expired, and error (those render
  // an interactive IdleAuth form); it is disabled while a device-auth flow
  // (pending/approved) or a busy auth action owns the screen.
  const globeDisabled = status === 'pending' || authFormBusy;
  const globeTrailing = I18nManager.isRTL ? { left: 16 } : { right: 16 };

  return (
    // iOS: automaticallyAdjustKeyboardInsets only made the ScrollView scrollable,
    // it never scrolls, and iOS only auto-reveals the focused field — so the
    // centered form kept "Send code" under the keyboard on shorter devices
    // (verified: iPhone 17 Pro, button centre 568pt vs keyboard window top 566pt,
    // taps swallowed by UIRemoteKeyboardWindow). "padding" shrinks the ScrollView
    // so the whole form re-centres in the space above the keyboard.
    //
    // Android: on API 35+ EDGE_TO_EDGE_ENFORCED the window never resizes for the
    // IME, so KeyboardAvoidingView is inert (r0b: zero layout shift for the email
    // IME). keyboardDidShow fires with real heights; the shell consumes them via
    // the padding wrapper below.
    <KeyboardAvoidingView behavior="padding" enabled={Platform.OS === 'ios'} className="flex-1">
      <View
        className="flex-1"
        // eslint-disable-next-line react-native/no-inline-styles -- dynamic keyboard padding
        style={{ paddingBottom: androidKeyboardPad }}
      >
        <Pressable
          onPress={() => {
            void (async () => {
              await persistLoginDrafts();
              setLanguagePickerOpen(true);
            })();
          }}
          disabled={globeDisabled}
          hitSlop={8}
          accessibilityRole="button"
          accessibilityLabel={t('common.language')}
          accessibilityState={{ disabled: globeDisabled }}
          className="absolute z-10 h-11 w-11 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
          // eslint-disable-next-line react-native/no-inline-styles -- safe-area + RTL-aware trailing edge
          style={{ top: insets.top + 8, ...globeTrailing }}
        >
          <Globe size={22} color={colors.foreground} />
        </Pressable>
        <ScrollView
          className="flex-1 bg-background"
          contentContainerClassName="flex-grow items-center justify-center gap-6 px-6 py-8"
          keyboardShouldPersistTaps="handled"
        >
          <View className="w-full max-w-sm items-center gap-2">
            <Image source={logo} className="mb-1 h-16 w-16" accessibilityLabel={t('login.logo')} />
            <Text className="text-center text-lg">{t('login.welcome')}</Text>
          </View>

          {/* Branch fade animations parked mid-flight on remount — e1 measured 2/2
              iOS logout→login remounts washed out at ~50% alpha for 3+ minutes,
              recovering only on relaunch — so these branches render without
              animation; status swaps are instant. */}
          <View className="w-full max-w-sm gap-3">
            {status === 'idle' && draft !== null && (
              <IdleAuth
                start={start}
                initialEmail={draft.email}
                initialSsoRecovery={draft.ssoRecovery}
                onBusyChange={setAuthFormBusy}
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
                    className="w-full flex-row flex-wrap gap-1"
                    onPress={() => {
                      void openBrowser();
                    }}
                    accessibilityLabel={t('login.openSignInPageInBrowser')}
                  >
                    <ExternalLink size={14} color={colors.foreground} />
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
                    <Text className="text-center">{t('login.copyLink')}</Text>
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

            {(status === 'denied' || status === 'expired' || status === 'error') && (
              <View className="w-full gap-3">
                <Text className="text-center text-sm text-destructive">
                  {errorMessage(status, error)}
                </Text>
                <IdleAuth
                  start={start}
                  initialEmail={draft?.email ?? ''}
                  initialSsoRecovery={draft?.ssoRecovery ?? null}
                  onBusyChange={setAuthFormBusy}
                />
              </View>
            )}
          </View>
        </ScrollView>
      </View>
      <LanguagePickerSheet
        visible={languagePickerOpen}
        onClose={() => {
          setLanguagePickerOpen(false);
        }}
        returnTarget="login"
      />
    </KeyboardAvoidingView>
  );
}
