import {
  checkGraceExpired,
  isProvisioningTerminal,
  type OnboardingState,
  shouldAdvanceFromProvisioning,
} from '@/lib/onboarding';
import { AlertTriangle } from 'lucide-react-native';
import { useEffect } from 'react';
import { ActivityIndicator, View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type ProvisioningStepProps = {
  state: OnboardingState;
  onGraceElapsed: () => void;
  onComplete: () => void;
  onRetry: () => void;
};

export function ProvisioningStep({
  state,
  onGraceElapsed,
  onComplete,
  onRetry,
}: Readonly<ProvisioningStepProps>) {
  const colors = useThemeColors();

  // 502-grace poll: tick once per second while we're holding a 502 and the
  // grace window hasn't elapsed. Checked against the pure helper so the
  // timing logic stays testable.
  const { first502AtMs, gateway502Expired } = state;
  useEffect(() => {
    if (first502AtMs === null || gateway502Expired) {
      return undefined;
    }
    const interval = setInterval(() => {
      if (checkGraceExpired({ first502AtMs }, Date.now())) {
        onGraceElapsed();
      }
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [first502AtMs, gateway502Expired, onGraceElapsed]);

  // Advance to the done step once the instance + gateway gate holds. Step
  // saves are dispatched from OnboardingFlow and their apply is guaranteed by
  // the DO's pending-flush hook, so the client no longer waits for a
  // client-side config-applied signal here.
  const advance = shouldAdvanceFromProvisioning(state);
  useEffect(() => {
    if (advance) {
      onComplete();
    }
  }, [advance, onComplete]);

  if (isProvisioningTerminal(state)) {
    return (
      <Animated.View
        entering={FadeIn.duration(200)}
        className="flex-1 items-center justify-center gap-6 px-6"
      >
        <View className="h-20 w-20 items-center justify-center rounded-2xl bg-red-500/15">
          <AlertTriangle size={40} color={colors.destructive} />
        </View>
        <View className="gap-2">
          <Text variant="large" className="text-center">
            Provisioning failed
          </Text>
          <Text variant="muted" className="text-center">
            Something went wrong while setting up your instance. Try again, or contact support at
            hi@kilo.ai if the problem persists.
          </Text>
        </View>
        <Button size="lg" className="w-full" onPress={onRetry}>
          <Text>Try again</Text>
        </Button>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className="flex-1 items-center justify-center gap-6 px-6"
    >
      <ActivityIndicator size="large" color={colors.primary} />
      <View className="gap-2">
        <Text variant="large" className="text-center">
          Setting up your instance
        </Text>
        <Text variant="muted" className="text-center">
          This usually takes a few minutes. You can close this — we&apos;ll finish in the
          background.
        </Text>
      </View>
    </Animated.View>
  );
}
