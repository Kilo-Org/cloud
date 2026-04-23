import {
  AlertTriangle,
  Clock,
  LifeBuoy,
  type LucideIcon,
  PauseCircle,
  ShieldAlert,
} from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Linking, Pressable, View } from 'react-native';

import { Text } from '@/components/ui/text';
import {
  ACCESS_REQUIRED_SHOWN_EVENT,
  type AccessRequiredSubcase,
} from '@/lib/analytics/onboarding-events';
import { trackEvent } from '@/lib/appsflyer';
import { WEB_BASE_URL } from '@/lib/config';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

export type { AccessRequiredSubcase };

type SubcaseContent = {
  icon: LucideIcon;
  title: string;
  body: string;
  pointer: string;
};

const SUBCASE_CONTENT: Record<AccessRequiredSubcase, SubcaseContent> = {
  trial_expired: {
    icon: Clock,
    title: 'Subscribe on the web',
    body: "To keep using KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
    pointer: 'kilo.ai/claw',
  },
  subscription_canceled: {
    icon: PauseCircle,
    title: 'Subscribe on the web',
    body: "To use KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
    pointer: 'kilo.ai/claw',
  },
  subscription_past_due: {
    icon: AlertTriangle,
    title: 'Update payment on the web',
    body: "We had trouble with your most recent payment. Go to kilo.ai/claw from your browser to update it. You can't manage billing in the app.",
    pointer: 'kilo.ai/claw',
  },
  quarantined: {
    icon: ShieldAlert,
    title: 'Instance needs remediation',
    body: "Your KiloClaw instance is in a quarantined state and can't be used right now. Our team needs to help restore it.",
    pointer: 'Continue on kilo.ai to get support.',
  },
  multiple_current_conflict: {
    icon: AlertTriangle,
    title: 'Account needs review',
    body: "We found more than one active subscription on your account, so we've paused things to avoid double-billing you.",
    pointer: 'Continue on kilo.ai to contact support.',
  },
  non_canonical_earlybird: {
    icon: LifeBuoy,
    title: 'Legacy plan detected',
    body: 'Your early-access plan needs a manual review before it can be used on mobile.',
    pointer: 'Continue on kilo.ai to contact support.',
  },
};

const SUBSCRIBE_SUBCASES: ReadonlySet<AccessRequiredSubcase> = new Set([
  'trial_expired',
  'subscription_canceled',
  'subscription_past_due',
]);

type AccessRequiredScreenProps = {
  subcase: AccessRequiredSubcase;
};

export function AccessRequiredScreen({ subcase }: Readonly<AccessRequiredScreenProps>) {
  const colors = useThemeColors();
  const content = SUBCASE_CONTENT[subcase];
  const Icon = content.icon;

  const trackedSubcaseRef = useRef<AccessRequiredSubcase | null>(null);
  useEffect(() => {
    if (trackedSubcaseRef.current === subcase) {
      return;
    }
    trackedSubcaseRef.current = subcase;
    trackEvent(ACCESS_REQUIRED_SHOWN_EVENT, { subcase });
  }, [subcase]);

  return (
    <View className="items-center justify-center gap-4 px-6">
      <View className="items-center justify-center rounded-full bg-neutral-200 p-4 dark:bg-neutral-800">
        <Icon size={32} color={colors.mutedForeground} />
      </View>
      <View className="items-center gap-2">
        <Text variant="large" className="text-center">
          {content.title}
        </Text>
        <Text variant="muted" className="text-center">
          {content.body}
        </Text>
      </View>
      <Pressable
        accessibilityRole="link"
        onPress={() => {
          const target = SUBSCRIBE_SUBCASES.has(subcase) ? `${WEB_BASE_URL}/claw` : WEB_BASE_URL;
          void Linking.openURL(target);
        }}
        hitSlop={8}
      >
        <Text variant="muted" className="text-center underline">
          {content.pointer}
        </Text>
      </Pressable>
    </View>
  );
}
