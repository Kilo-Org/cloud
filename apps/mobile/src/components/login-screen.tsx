import * as Clipboard from 'expo-clipboard';
import { ExternalLink } from 'lucide-react-native';
import { useCallback, useEffect, useState } from 'react';
import { ActivityIndicator, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import logo from '@/../assets/images/logo.png';
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

export function LoginScreen() {
  const { signIn } = useAuth();
  const { status, token, code, error, verificationUrl, start, cancel, openBrowser } =
    useDeviceAuth();
  const colors = useThemeColors();
  const [persistError, setPersistError] = useState<string | undefined>(undefined);

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

  return (
    <ScrollView
      className="flex-1 bg-background"
      contentContainerClassName="flex-grow items-center justify-center gap-6 px-6"
      automaticallyAdjustKeyboardInsets
      keyboardShouldPersistTaps="handled"
    >
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
                <Text>Open in browser</Text>
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
                <Text numberOfLines={1}>Copy link</Text>
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
            <Button variant="ghost" onPress={cancel} accessibilityLabel="Cancel sign in">
              <Text>Cancel</Text>
            </Button>
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
            <IdleAuth start={start} />
          </Animated.View>
        )}
      </Animated.View>
    </ScrollView>
  );
}
