import { AlertTriangle, ShieldAlert } from 'lucide-react-native';
import { View } from 'react-native';
import Animated, { FadeIn } from 'react-native-reanimated';

import { CompleteStep } from '@/components/kiloclaw/onboarding/complete-step';
import { IdentityStep } from '@/components/kiloclaw/onboarding/identity-step';
import { NotificationsStep } from '@/components/kiloclaw/onboarding/notifications-step';
import { ProvisioningStep } from '@/components/kiloclaw/onboarding/provisioning-step';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toneColor } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type BotIdentity, type OnboardingState } from '@/lib/onboarding';
import { cn } from '@/lib/utils';

type FlowBodyProps = {
  state: OnboardingState;
  onIdentityContinue: (identity: BotIdentity, weatherLocation: string | null) => void;
  onNotificationsComplete: () => void;
  onProvisioningComplete: () => void;
  onRetry: () => void;
  onGraceElapsed: () => void;
  onOpenInstance: () => void;
};

export function FlowBody(props: Readonly<FlowBodyProps>) {
  const {
    state,
    onIdentityContinue,
    onNotificationsComplete,
    onProvisioningComplete,
    onRetry,
    onGraceElapsed,
    onOpenInstance,
  } = props;
  const colors = useThemeColors();
  const { errorCategory, provisionSuccess, step, botIdentity } = state;

  if (errorCategory === 'access_conflict') {
    const warn = toneColor('warn');
    return (
      <Animated.View
        key="access-conflict"
        entering={FadeIn.duration(200)}
        className="flex-1 items-center justify-center gap-6 px-6"
      >
        <View
          className={cn(
            'h-24 w-24 items-center justify-center rounded-3xl border',
            warn.tileBgClass,
            warn.tileBorderClass
          )}
        >
          <ShieldAlert size={40} color={colors.warn} />
        </View>
        <View className="items-center gap-2">
          <Text variant="eyebrow" className="text-xs">
            Review
          </Text>
          <Text className="text-center text-2xl font-semibold">Setup needs manual review</Text>
          <Text variant="muted" className="text-center text-base">
            Your account state needs attention before we can create an instance. Continue on kilo.ai
            to finish setting up.
          </Text>
        </View>
      </Animated.View>
    );
  }

  if (errorCategory === 'generic') {
    const danger = toneColor('danger');
    return (
      <Animated.View
        key="generic-error"
        entering={FadeIn.duration(200)}
        className="flex-1 items-center justify-center gap-6 px-6"
      >
        <View
          className={cn(
            'h-24 w-24 items-center justify-center rounded-3xl border',
            danger.tileBgClass,
            danger.tileBorderClass
          )}
        >
          <AlertTriangle size={40} color={colors.destructive} />
        </View>
        <View className="items-center gap-2">
          <Text variant="eyebrow" className="text-xs">
            Provisioning
          </Text>
          <Text className="text-center text-2xl font-semibold">Something went wrong</Text>
          <Text variant="muted" className="text-center text-base">
            We couldn&apos;t finish setting up your instance just now.
          </Text>
        </View>
        <Button size="lg" className="w-full" onPress={onRetry}>
          <Text className="text-base">Try again</Text>
        </Button>
      </Animated.View>
    );
  }

  if (step === 'identity') {
    return (
      <Animated.View key="identity" entering={FadeIn.duration(200)} className="flex-1">
        <IdentityStep
          onContinue={onIdentityContinue}
          initialIdentity={botIdentity}
          initialWeatherLocation={state.weatherLocation}
        />
      </Animated.View>
    );
  }

  if (step === 'channels') {
    return (
      <Animated.View key="notifications" entering={FadeIn.duration(200)} className="flex-1">
        <NotificationsStep onComplete={onNotificationsComplete} botIdentity={botIdentity} />
      </Animated.View>
    );
  }

  if (step === 'done' && provisionSuccess) {
    return (
      <Animated.View key="done" entering={FadeIn.duration(200)} className="flex-1">
        <CompleteStep botIdentity={botIdentity} onOpen={onOpenInstance} />
      </Animated.View>
    );
  }

  return (
    <Animated.View key="provisioning" entering={FadeIn.duration(200)} className="flex-1">
      <ProvisioningStep
        state={state}
        onComplete={onProvisioningComplete}
        onGraceElapsed={onGraceElapsed}
        onRetry={onRetry}
      />
    </Animated.View>
  );
}
