import * as Clipboard from 'expo-clipboard';
import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
  isAvailableAsync as isAppleAuthAvailableAsync,
} from 'expo-apple-authentication';
import { ExternalLink } from 'lucide-react-native';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, TextInput, useColorScheme, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import logo from '@/../assets/images/logo.png';
import { EmailOtpForm } from '@/components/login/email-otp-form';
import { GoogleLogo } from '@/components/login/google-logo';
import { Button } from '@/components/ui/button';
import { Image } from '@/components/ui/image';
import { Text } from '@/components/ui/text';
import { useAuth } from '@/lib/auth/auth-context';
import { useDeviceAuth } from '@/lib/auth/use-device-auth';
import { useNativeAuth } from '@/lib/auth/use-native-auth';
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

function AuthButtons({ start }: { start: (mode: 'signin' | 'signup') => Promise<void> }) {
  return (
    <>
      <Button
        size="lg"
        onPress={() => {
          void start('signin');
        }}
        accessibilityLabel="Sign in with browser"
      >
        <Text>Sign In</Text>
      </Button>
      <Button
        variant="outline"
        size="lg"
        onPress={() => {
          void start('signup');
        }}
        accessibilityLabel="Create a new account"
      >
        <Text>Create Account</Text>
      </Button>
    </>
  );
}

function IdleAuth({ start }: Readonly<{ start: (mode: 'signin' | 'signup') => Promise<void> }>) {
  const colors = useThemeColors();
  const colorScheme = useColorScheme();
  const {
    busy,
    googleConfigured,
    signInWithApple,
    signInWithGoogle,
    requestEmailCode,
    verifyEmailCode,
  } = useNativeAuth();
  const [view, setView] = useState<'main' | 'otp'>('main');
  const [appleAvailable, setAppleAvailable] = useState(false);
  const emailRef = useRef('');

  useEffect(() => {
    if (Platform.OS !== 'ios') {
      return;
    }
    const checkAppleAvailability = async () => {
      try {
        setAppleAvailable(await isAppleAuthAvailableAsync());
      } catch {
        setAppleAvailable(false);
      }
    };
    void checkAppleAvailability();
  }, []);

  const handleSendCode = async () => {
    const ok = await requestEmailCode(emailRef.current);
    if (ok) {
      setView('otp');
    }
  };

  const showApple = Platform.OS === 'ios' && appleAvailable;
  const showDivider = showApple || googleConfigured;

  if (view === 'otp') {
    return (
      <EmailOtpForm
        email={emailRef.current.trim().toLowerCase()}
        busy={busy}
        onVerify={code => {
          void verifyEmailCode(emailRef.current, code);
        }}
        onResend={() => {
          void requestEmailCode(emailRef.current);
        }}
        onBack={() => {
          setView('main');
        }}
      />
    );
  }

  return (
    <View className="gap-3">
      {showApple && (
        <AppleAuthenticationButton
          buttonType={AppleAuthenticationButtonType.SIGN_IN}
          buttonStyle={
            colorScheme === 'dark'
              ? AppleAuthenticationButtonStyle.WHITE
              : AppleAuthenticationButtonStyle.BLACK
          }
          cornerRadius={8}
          // eslint-disable-next-line react-native/no-inline-styles -- AppleAuthenticationButton isn't NativeWind-aware; height/width must be set via style, not className
          style={{ height: 44, width: '100%' }}
          onPress={() => {
            if (busy) {
              return;
            }
            void signInWithApple();
          }}
          accessibilityLabel="Sign in with Apple"
        />
      )}

      {googleConfigured && (
        <Button
          variant="outline"
          size="lg"
          // Match the native Apple button exactly: 44pt tall, cornerRadius 8, full width.
          className="h-[44px] w-full flex-row gap-2 rounded-[8px]"
          disabled={busy === 'google'}
          onPress={() => void signInWithGoogle()}
          accessibilityLabel="Sign in with Google"
        >
          {busy === 'google' ? <ActivityIndicator size="small" /> : <GoogleLogo size={18} />}
          <Text className="text-[17px] font-medium">Sign in with Google</Text>
        </Button>
      )}

      {showDivider && (
        <View className="flex-row items-center gap-3">
          <View className="h-px flex-1 bg-border" />
          <Text variant="muted" className="text-xs">
            or
          </Text>
          <View className="h-px flex-1 bg-border" />
        </View>
      )}

      <TextInput
        className="h-12 rounded-md border border-input bg-background px-3 text-sm leading-5 text-foreground"
        placeholder="Email address"
        placeholderTextColor={colors.mutedForeground}
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        onChangeText={value => {
          emailRef.current = value;
        }}
        accessibilityLabel="Email address"
      />
      <Button
        size="lg"
        className="flex-row gap-2"
        disabled={busy === 'otp-send'}
        onPress={() => void handleSendCode()}
        accessibilityLabel="Send sign-in code"
      >
        {busy === 'otp-send' ? <ActivityIndicator size="small" /> : null}
        <Text>Send code</Text>
      </Button>
      <Button
        variant="ghost"
        onPress={() => {
          void start('signin');
        }}
        accessibilityLabel="More sign-in options"
      >
        <Text>More sign-in options</Text>
      </Button>
    </View>
  );
}

export function LoginScreen() {
  const { signIn } = useAuth();
  const { status, token, code, error, verificationUrl, start, cancel, openBrowser } =
    useDeviceAuth();
  const colors = useThemeColors();

  useEffect(() => {
    if (status === 'approved' && token) {
      void signIn(token);
    }
  }, [status, token, signIn]);

  if (status === 'approved') {
    return <View className="flex-1 bg-background" />;
  }

  return (
    <View className="flex-1 items-center justify-center gap-6 bg-background px-6">
      <View className="items-center gap-2">
        <Image source={logo} className="mb-1 h-16 w-16" accessibilityLabel="Kilo logo" />
        <Text className="text-lg">Welcome to Kilo Code</Text>
      </View>

      <Animated.View className="w-full max-w-sm gap-3" layout={LinearTransition}>
        {status === 'idle' && (
          <Animated.View
            className="gap-3"
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
          >
            <IdleAuth start={start} />
          </Animated.View>
        )}

        {status === 'pending' && code && (
          <Animated.View
            className="items-center gap-4"
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
          >
            <Text variant="muted">Your sign-in code:</Text>
            <Text
              variant="h2"
              className="border-b-0 pb-0 tracking-widest"
              // eslint-disable-next-line @typescript-eslint/no-misused-spread -- code is always ASCII
              accessibilityLabel={`Sign in code: ${[...code].join(' ')}`}
              selectable
            >
              {code}
            </Text>
            <View className="flex-row gap-2">
              <Button
                variant="outline"
                size="sm"
                className="flex-row gap-1"
                onPress={() => {
                  void openBrowser();
                }}
                accessibilityLabel="Open sign-in page in browser"
              >
                <ExternalLink size={14} color={colors.foreground} />
                <Text>Open</Text>
              </Button>
              <Button
                variant="outline"
                size="sm"
                onPress={() => {
                  if (verificationUrl) {
                    void Clipboard.setStringAsync(verificationUrl);
                    toast('Copied to clipboard');
                  }
                }}
                accessibilityLabel="Copy sign-in link"
              >
                <Text numberOfLines={1}>Copy Link</Text>
              </Button>
            </View>
            <Button variant="ghost" onPress={cancel} accessibilityLabel="Cancel sign in">
              <Text>Cancel</Text>
            </Button>
          </Animated.View>
        )}

        {status === 'pending' && !code && (
          <Animated.View
            className="items-center gap-3"
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
          >
            <ActivityIndicator size="small" color={colors.mutedForeground} />
            <Text variant="muted">Starting sign in...</Text>
          </Animated.View>
        )}

        {(status === 'denied' || status === 'expired' || status === 'error') && (
          <Animated.View
            className="gap-3"
            entering={FadeIn.duration(200)}
            exiting={FadeOut.duration(150)}
          >
            <Text className="text-center text-sm text-destructive">
              {errorMessage(status, error)}
            </Text>
            <AuthButtons start={start} />
          </Animated.View>
        )}
      </Animated.View>
    </View>
  );
}
