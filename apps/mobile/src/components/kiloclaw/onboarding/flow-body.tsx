import { type OnboardingState } from '@/lib/onboarding';
import Animated, { FadeIn } from 'react-native-reanimated';

import { CompleteStep } from '@/components/kiloclaw/onboarding/complete-step';
import { IdentityStep } from '@/components/kiloclaw/onboarding/identity-step';
import { NotificationsStep } from '@/components/kiloclaw/onboarding/notifications-step';
import { ProvisioningStep } from '@/components/kiloclaw/onboarding/provisioning-step';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';

type BotIdentity = OnboardingState['botIdentity'];

type FlowBodyProps = {
  state: OnboardingState;
  onIdentityContinue: (identity: NonNullable<BotIdentity>, weatherLocation: string | null) => void;
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
  const { errorCategory, provisionSuccess, step, botIdentity } = state;

  if (errorCategory === 'access_conflict') {
    return (
      <Animated.View
        key="access-conflict"
        entering={FadeIn.duration(200)}
        className="mx-4 mt-4 gap-3 rounded-xl border border-border bg-card p-5"
      >
        <Text variant="large">Setup needs manual review</Text>
        <Text variant="muted">
          Your account state needs attention before we can create an instance. Continue on kilo.ai
          to finish setting up.
        </Text>
      </Animated.View>
    );
  }

  if (errorCategory === 'generic') {
    return (
      <Animated.View
        key="generic-error"
        entering={FadeIn.duration(200)}
        className="mx-4 mt-4 gap-3 rounded-xl border border-border bg-card p-5"
      >
        <Text variant="large">Something went wrong</Text>
        <Text variant="muted">We couldn&apos;t finish setting up your instance just now.</Text>
        <Button onPress={onRetry}>
          <Text>Try again</Text>
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
