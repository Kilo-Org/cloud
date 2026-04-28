import {
  checkGraceExpired,
  isProvisioningTerminal,
  type OnboardingState,
  shouldAdvanceFromProvisioning,
} from '@/lib/onboarding';
import { AlertTriangle } from 'lucide-react-native';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';
import Animated, {
  Easing,
  FadeIn,
  FadeOut,
  LinearTransition,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming,
} from 'react-native-reanimated';

import { Button } from '@/components/ui/button';
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
};

const STATUS_MESSAGE_TEMPLATES = [
  'Renting a small corner of the cloud…',
  'Handing {name} a name tag…',
  'Unpacking a fresh set of prompts…',
  'Teaching it where the kettle is…',
  'Warming up the silicon…',
  'Running a quick vibe check…',
  'Pouring {name} a cup of coffee…',
  'Double-checking the welcome memo…',
];

const STATUS_ROTATE_MS = 2600;
const PULSE_PEAK = 1.06;
const PULSE_DURATION_MS = 1400;

function personalizeMessages(name: string): readonly string[] {
  return STATUS_MESSAGE_TEMPLATES.map(m => m.replace('{name}', name));
}

export function ProvisioningStep({
  state,
  onGraceElapsed,
  onComplete,
  onRetry,
}: Readonly<ProvisioningStepProps>) {
  const colors = useThemeColors();

  const botEmoji = state.botIdentity?.botEmoji ?? DEFAULT_BOT_IDENTITY.botEmoji;
  const botName = state.botIdentity?.botName ?? DEFAULT_BOT_IDENTITY.botName;
  const tint = agentColor(botEmoji);

  const messages = useMemo(() => personalizeMessages(botName), [botName]);
  const [messageIndex, setMessageIndex] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      setMessageIndex(i => (i + 1) % messages.length);
    }, STATUS_ROTATE_MS);
    return () => {
      clearInterval(id);
    };
  }, [messages.length]);

  // Gentle breathing pulse on the avatar tile — signals "actively working"
  // without the spinner-in-the-middle-of-nowhere look.
  const pulse = useSharedValue(1);
  useEffect(() => {
    pulse.value = withRepeat(
      withTiming(PULSE_PEAK, {
        duration: PULSE_DURATION_MS,
        easing: Easing.inOut(Easing.ease),
      }),
      -1,
      true
    );
  }, [pulse]);
  const pulseStyle = useAnimatedStyle(() => ({
    transform: [{ scale: pulse.value }],
  }));

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
    const danger = toneColor('danger');
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
          <Text className="text-center text-2xl font-semibold">Something stalled</Text>
          <Text variant="muted" className="text-center text-base">
            We couldn&apos;t finish setting up {botName}. Try again, or email hi@kilo.ai if this
            keeps happening.
          </Text>
        </View>
        <Button size="lg" className="w-full" onPress={onRetry}>
          <Text className="text-base">Try again</Text>
        </Button>
      </Animated.View>
    );
  }

  const message = messages[messageIndex] ?? messages[0];

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
        <Text className="text-5xl">{botEmoji}</Text>
      </Animated.View>

      <View className="items-center gap-3">
        <View className="items-center gap-1">
          <Text variant="eyebrow" className="text-xs">
            Setting up
          </Text>
          <Text className="text-center text-2xl font-semibold">Waking up {botName}</Text>
        </View>

        <Animated.View layout={LinearTransition} className="min-h-[24px] items-center">
          <Animated.View
            key={messageIndex}
            entering={FadeIn.duration(400)}
            exiting={FadeOut.duration(250)}
          >
            <Text variant="muted" className="text-center text-base">
              {message}
            </Text>
          </Animated.View>
        </Animated.View>
      </View>

      <Text variant="muted" className="text-center">
        You can close this — we&apos;ll keep working in the background.
      </Text>
    </Animated.View>
  );
}
