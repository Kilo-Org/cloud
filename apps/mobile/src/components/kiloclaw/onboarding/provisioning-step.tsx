import {
  checkGraceExpired,
  getProvisioningTerminalReason,
  type OnboardingState,
  type ProvisioningTerminalReason,
  shouldAdvanceFromProvisioning,
} from '@/lib/onboarding';
import { AlertTriangle } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  cancelAnimation,
  Easing,
  FadeIn,
  FadeOut,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
import { BotAvatar } from '@/components/kiloclaw/bot-avatar';
import { Text } from '@/components/ui/text';
import { agentColor, toneColor } from '@/lib/agent-color';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

import { DEFAULT_BOT_IDENTITY } from './state';

type ProvisioningStepProps = {
  state: OnboardingState;
  onGraceElapsed: () => void;
  onComplete: () => void;
  onRetry: () => void;
  onContinueInBackground: () => void;
};

// Overall wall-clock budget for provisioning before we tell the user it's
// stalled, rather than pulsing an indefinite "waking up" message. Resets
// per mount, which happens on every fresh entry into the provisioning step
// (including after a retry — see `flow-body.tsx`'s `key="provisioning"`).
const OVERALL_TIMEOUT_MS = 150_000;
const PULSE_PEAK = 1.06;
const PULSE_DURATION_MS = 1400;

const TERMINAL_CONTENT: Record<
  ProvisioningTerminalReason,
  { title: string; body: (name: string) => string }
> = {
  query_error: {
    title: "Couldn't check on setup",
    body: name =>
      `We lost the connection while checking on ${name}'s setup. It may still be running. Try again, or check back shortly.`,
  },
  instance_stopped: {
    title: 'Setup stopped',
    body: name => `${name}'s instance stopped unexpectedly during setup.`,
  },
  gateway_502: {
    title: 'Something stalled',
    body: name =>
      `We couldn't finish setting up ${name}. Try again, or email hi@kilo.ai if this keeps happening.`,
  },
  timeout: {
    title: 'Taking longer than expected',
    body: name =>
      `Setup for ${name} is taking longer than usual (over ${OVERALL_TIMEOUT_MS / 60_000} minutes).`,
  },
};

function provisioningStageMessage(state: OnboardingState): string {
  if (state.instanceStatus === 'running' && state.gatewayReady && !state.gatewaySettled) {
    return 'Finishing setup';
  }
  if (state.instanceStatus === 'running' && !state.gatewayReady) {
    return 'Connecting to the agent';
  }
  return 'Starting the sandbox';
}

export function ProvisioningStep({
  state,
  onGraceElapsed,
  onComplete,
  onRetry,
  onContinueInBackground,
}: Readonly<ProvisioningStepProps>) {
  const colors = useThemeColors();

  const botEmoji = state.botIdentity?.botEmoji ?? DEFAULT_BOT_IDENTITY.botEmoji;
  const botName = state.botIdentity?.botName ?? DEFAULT_BOT_IDENTITY.botName;
  const tint = agentColor(botEmoji);

  // Overall wall-clock timeout: local to this component since it's the only
  // producer and consumer. Resets naturally on retry, same as `enteredAtMs`
  // below — a retry sends `state.step` back to `identity`, which unmounts
  // this component (see `key="provisioning"` in `flow-body.tsx`), so both
  // reset fresh on the next entry into provisioning.
  const [timedOut, setTimedOut] = useState(false);

  const terminalReason = getProvisioningTerminalReason(state, timedOut);
  const stageMessage = useMemo(() => provisioningStageMessage(state), [state]);

  // Gentle breathing pulse on the avatar tile — signals "actively working"
  // without the spinner-in-the-middle-of-nowhere look. Static tile when
  // Reduce Motion is on, same as Skeleton/SpinningIcon.
  const reducedMotion = useReducedMotion();
  const pulse = useSharedValue(1);
  useEffect(() => {
    if (reducedMotion) {
      return undefined;
    }
    pulse.value = withRepeat(
      withTiming(PULSE_PEAK, {
        duration: PULSE_DURATION_MS,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true
    );
    return () => {
      cancelAnimation(pulse);
    };
  }, [pulse, reducedMotion]);
  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

  // The overall-timeout clock starts at mount, which happens fresh every
  // time this step is (re)entered — see the `key="provisioning"` on the
  // FlowBody branch that renders this component.
  const [enteredAtMs] = useState(() => Date.now());

  // Single 1s poll while provisioning is live and not yet terminal: checks
  // both the 502-grace sub-machine (pure `checkGraceExpired` helper) and the
  // overall wall-clock budget, acting on whichever fires.
  const { first502AtMs, gateway502Expired } = state;
  useEffect(() => {
    if (terminalReason !== null) {
      return undefined;
    }
    const interval = setInterval(() => {
      const nowMs = Date.now();
      if (
        first502AtMs !== null &&
        !gateway502Expired &&
        checkGraceExpired({ first502AtMs }, nowMs)
      ) {
        onGraceElapsed();
      }
      if (!timedOut && nowMs - enteredAtMs >= OVERALL_TIMEOUT_MS) {
        setTimedOut(true);
      }
    }, 1000);
    return () => {
      clearInterval(interval);
    };
  }, [terminalReason, first502AtMs, gateway502Expired, timedOut, enteredAtMs, onGraceElapsed]);

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

  if (terminalReason !== null) {
    const danger = toneColor('danger');
    const content = TERMINAL_CONTENT[terminalReason];
    return (
      <Animated.View
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
          <Text className="text-center text-2xl font-semibold">{content.title}</Text>
          <Text variant="muted" className="text-center text-base">
            {content.body(botName)}
          </Text>
        </View>
        <View className="w-full gap-3">
          <Button size="lg" className="w-full" onPress={onRetry}>
            <Text className="text-base">Try again</Text>
          </Button>
          <Button variant="ghost" size="lg" className="w-full" onPress={onContinueInBackground}>
            <Text className="text-base">Continue in background</Text>
          </Button>
        </View>
      </Animated.View>
    );
  }

  return (
    <Animated.View
      entering={FadeIn.duration(200)}
      className="flex-1 items-center justify-center gap-6 px-6"
    >
      <Animated.View
        style={pulseStyle}
        className={cn(
          'h-24 w-24 items-center justify-center rounded-3xl border',
          tint.tileBgClass,
          tint.tileBorderClass
        )}
      >
        <BotAvatar emoji={botEmoji} size={48} color={colors.foreground} />
      </Animated.View>

      <View className="items-center gap-3">
        <View className="items-center gap-1">
          <Text variant="eyebrow" className="text-xs">
            Provisioning
          </Text>
          <Text className="text-center text-2xl font-semibold">Setting up {botName}</Text>
        </View>

        <Animated.View
          key={stageMessage}
          entering={FadeIn.duration(300)}
          exiting={FadeOut.duration(200)}
        >
          <Text variant="muted" className="text-center text-base">
            {stageMessage}
          </Text>
        </Animated.View>
      </View>

      <Text variant="muted" className="text-center">
        Usually takes under a minute. You can close this — we&apos;ll keep working in the
        background.
      </Text>
    </Animated.View>
  );
}
