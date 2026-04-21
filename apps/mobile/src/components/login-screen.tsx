import * as Clipboard from 'expo-clipboard';
import { ExternalLink } from 'lucide-react-native';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import logo from '@/../assets/images/logo.png';
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
      return 'Access was denied. Please contact your administrator.';
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
            <AuthButtons start={start} />
            <Text variant="muted" className="text-center text-xs">
              You will be redirected to your browser
            </Text>
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
                <Text>Copy Link</Text>
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
