import * as Clipboard from 'expo-clipboard';
import { ExternalLink } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  KeyboardAvoidingView,
  type KeyboardEvent,
  Platform,
  ScrollView,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { toast } from 'sonner-native';

import logo from '@/../assets/images/logo.png';
import {
  resolveAppAwareKeyboardPadding,
  resolveKeyboardPaddingEventsForPlatform,
} from '@/components/kilo-chat/app-aware-keyboard-padding-state';
import { IdleAuth } from '@/components/login/idle-auth';
import { Button } from '@/components/ui/button';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useDeviceAuth } from '@/lib/auth/use-device-auth';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

function errorMessage(status: string, fallback: string | undefined) {
  switch (status) {
    case 'expired': {
      return 'Your sign-in code has expired. Please try again.';
    }
    case 'denied': {
      return 'Access was denied.';
    }
    default: {
      return fallback ?? 'Something went wrong. Please try again.';
    }
  }
}

function keyboardHeightFromEvent(event: KeyboardEvent): number {
  return event.endCoordinates.height;
}

export function LoginScreen() {
  const { signIn } = useAuth();
  const { status, token, code, error, verificationUrl, start, cancel, openBrowser } =
    useDeviceAuth();
  const colors = useThemeColors();
  const insets = useSafeAreaInsets();
  const [persistError, setPersistError] = useState<string | undefined>(undefined);
  const [androidKeyboardHeight, setAndroidKeyboardHeight] = useState(0);

  const persistToken = useCallback(
    async (tokenValue: string) => {
      setPersistError(undefined);
      try {
        await signIn(tokenValue);
      } catch {
        setPersistError('Could not complete sign in. Please try again.');
      }
    },
    [signIn]
  );

  useEffect(() => {
    if (status === 'approved' && token) {
      void persistToken(token);
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
                void persistToken(token);
              }
            }}
            accessibilityLabel="Retry sign in"
          >
            <Text>Retry</Text>
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
        <ScrollView
          className="flex-1 bg-background"
          contentContainerClassName="flex-grow items-center justify-center gap-6 px-6 py-8"
          keyboardShouldPersistTaps="handled"
        >
          <View className="w-full max-w-sm items-center gap-2">
            <Image source={logo} className="mb-1 h-16 w-16" accessibilityLabel="Kilo logo" />
            <Text className="text-center text-lg">Welcome to Kilo Code</Text>
          </View>

          <Animated.View className="w-full max-w-sm gap-3" layout={LinearTransition}>
            {status === 'idle' && (
              <Animated.View
                className="w-full gap-3"
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(150)}
              >
                <IdleAuth start={start} />
              </Animated.View>
            )}

            {status === 'pending' && code && (
              <Animated.View
                className="w-full items-center gap-4"
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(150)}
              >
                <Text variant="muted" className="text-center">
                  Your sign-in code:
                </Text>
                <Text
                  variant="h2"
                  className="border-b-0 pb-0 text-center tracking-widest"
                  // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code is always ASCII
                  accessibilityLabel={`Sign in code: ${[...code].join(' ')}`}
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
                    accessibilityLabel="Open sign-in page in browser"
                  >
                    <ExternalLink size={14} color={colors.foreground} />
                    <Text className="text-center">Open in browser</Text>
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full"
                    onPress={() => {
                      if (verificationUrl) {
                        void Clipboard.setStringAsync(verificationUrl);
                        toast('Copied to clipboard');
                      }
                    }}
                    accessibilityLabel="Copy sign-in link"
                  >
                    <Text className="text-center">Copy link</Text>
                  </Button>
                </View>
                <Button variant="ghost" onPress={cancel} accessibilityLabel="Cancel sign in">
                  <Text>Cancel</Text>
                </Button>
              </Animated.View>
            )}

            {status === 'pending' && !code && (
              <Animated.View
                className="w-full items-center gap-3"
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(150)}
              >
                <ActivityIndicator size="small" color={colors.mutedForeground} />
                <Text variant="muted" className="text-center">
                  Starting sign in...
                </Text>
                <Button variant="ghost" onPress={cancel} accessibilityLabel="Cancel sign in">
                  <Text>Cancel</Text>
                </Button>
              </Animated.View>
            )}

            {(status === 'denied' || status === 'expired' || status === 'error') && (
              <Animated.View
                className="w-full gap-3"
                entering={FadeIn.duration(200)}
                exiting={FadeOut.duration(150)}
              >
                <Text className="text-center text-sm text-destructive">
                  {errorMessage(status, error)}
                </Text>
                <IdleAuth start={start} />
              </Animated.View>
            )}
          </Animated.View>
        </ScrollView>
      </View>
    </KeyboardAvoidingView>
  );
}
