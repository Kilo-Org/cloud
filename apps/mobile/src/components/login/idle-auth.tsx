import {
  AppleAuthenticationButton,
  AppleAuthenticationButtonStyle,
  AppleAuthenticationButtonType,
  isAvailableAsync as isAppleAuthAvailableAsync,
} from 'expo-apple-authentication';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Platform, useColorScheme, View } from 'react-native';
import { toast } from 'sonner-native';

import { EmailOtpForm } from '@/components/login/email-otp-form';
import { GoogleLogo } from '@/components/login/google-logo';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { useNativeAuth } from '@/lib/auth/use-native-auth';

export function IdleAuth({
  start,
}: Readonly<{ start: (mode: 'signin' | 'signup') => Promise<void> }>) {
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
  const [browserAuthStarting, setBrowserAuthStarting] = useState(false);
  const emailRef = useRef('');
  const browserAuthStartingRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    const checkAppleAvailability = async () => {
      if (Platform.OS !== 'ios') {
        return;
      }
      try {
        const available = await isAppleAuthAvailableAsync();
        if (!cancelled) {
          setAppleAvailable(available);
        }
      } catch {
        if (!cancelled) {
          setAppleAvailable(false);
        }
      }
    };
    void checkAppleAvailability();
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSendCode = async () => {
    const ok = await requestEmailCode(emailRef.current);
    if (ok) {
      setView('otp');
    }
  };

  const showApple = Platform.OS === 'ios' && appleAvailable;
  const showDivider = showApple || googleConfigured;
  const authBusy = busy !== undefined || browserAuthStarting;

  const startBrowserAuth = async () => {
    if (browserAuthStartingRef.current) {
      return;
    }
    browserAuthStartingRef.current = true;
    setBrowserAuthStarting(true);
    try {
      await start('signin');
    } finally {
      browserAuthStartingRef.current = false;
      setBrowserAuthStarting(false);
    }
  };

  if (view === 'otp') {
    return (
      <EmailOtpForm
        email={emailRef.current.trim().toLowerCase()}
        busy={busy}
        onVerify={code => {
          void verifyEmailCode(emailRef.current, code);
        }}
        onResend={() => {
          void (async () => {
            const ok = await requestEmailCode(emailRef.current);
            if (ok) {
              toast.success('Code sent');
            }
          })();
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
        <View
          className={authBusy ? 'opacity-50' : undefined}
          pointerEvents={authBusy ? 'none' : 'auto'}
        >
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
              if (!authBusy) {
                void signInWithApple();
              }
            }}
            accessibilityLabel="Sign in with Apple"
          />
        </View>
      )}

      {googleConfigured && (
        <Button
          variant="outline"
          size="lg"
          className="h-[44px] w-full flex-row gap-2 rounded-[8px]"
          disabled={authBusy}
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

      <FormField
        label="Email address"
        placeholder="you@example.com"
        keyboardType="email-address"
        autoCapitalize="none"
        autoCorrect={false}
        autoComplete="email"
        textContentType="emailAddress"
        onChangeText={value => {
          emailRef.current = value;
        }}
      />
      <Button
        size="lg"
        className="flex-row gap-2"
        disabled={authBusy}
        onPress={() => void handleSendCode()}
        accessibilityLabel="Send sign-in code"
      >
        {busy === 'otp-send' ? <ActivityIndicator size="small" /> : null}
        <Text>Send code</Text>
      </Button>
      <Button
        variant="ghost"
        disabled={authBusy}
        onPress={() => {
          void startBrowserAuth();
        }}
        accessibilityLabel="More sign-in options"
      >
        <Text>More sign-in options</Text>
      </Button>
    </View>
  );
}
