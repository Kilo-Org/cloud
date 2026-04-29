import {
  AlertTriangle,
  Clock,
  ExternalLink,
  LifeBuoy,
  type LucideIcon,
  PauseCircle,
  ShieldAlert,
} from 'lucide-react-native';
import { useEffect, useRef } from 'react';
import { Linking, View } from 'react-native';

import { Button, type ButtonProps } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toneColor, type ToneKey } from '@/lib/agent-color';
import {
  ACCESS_REQUIRED_SHOWN_EVENT,
  type AccessRequiredSubcase,
} from '@/lib/analytics/onboarding-events';
import { trackEvent } from '@/lib/appsflyer';
import { WEB_BASE_URL } from '@/lib/config';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

type CtaVariant = Extract<ButtonProps['variant'], 'default' | 'outline'>;

export type { AccessRequiredSubcase };

type SubcaseContent = {
  icon: LucideIcon;
  tone: ToneKey;
  title: string;
  body: string;
  ctaLabel: string;
  ctaVariant: CtaVariant;
};

const SUBCASE_CONTENT: Record<AccessRequiredSubcase, SubcaseContent> = {
  trial_expired: {
    icon: Clock,
    tone: 'warn',
    title: 'Subscribe on the web',
    body: "To keep using KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
  },
  subscription_canceled: {
    icon: PauseCircle,
    tone: 'warn',
    title: 'Subscribe on the web',
    body: "To use KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
  },
  subscription_past_due: {
    icon: AlertTriangle,
    tone: 'danger',
    title: 'Update payment on the web',
    body: "We had trouble with your most recent payment. Go to kilo.ai/claw from your browser to update it. You can't manage billing in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
  },
  quarantined: {
    icon: ShieldAlert,
    tone: 'danger',
    title: 'Instance needs remediation',
    body: "Your KiloClaw instance is in a quarantined state and can't be used right now. Our team needs to help restore it.",
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
  },
  multiple_current_conflict: {
    icon: AlertTriangle,
    tone: 'warn',
    title: 'Account needs review',
    body: "We found more than one active subscription on your account, so we've paused things to avoid double-billing you.",
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
  },
  non_canonical_earlybird: {
    icon: LifeBuoy,
    tone: 'warn',
    title: 'Legacy plan detected',
    body: 'Your early-access plan needs a manual review before it can be used on mobile.',
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
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
  const tint = toneColor(content.tone);
  const iconColor = colors[tint.hueThemeKey];
  const ctaIconColor =
    content.ctaVariant === 'default' ? colors.primaryForeground : colors.foreground;

  const trackedSubcaseRef = useRef<AccessRequiredSubcase | null>(null);
  useEffect(() => {
    if (trackedSubcaseRef.current === subcase) {
      return;
    }
    trackedSubcaseRef.current = subcase;
    trackEvent(ACCESS_REQUIRED_SHOWN_EVENT, { subcase });
  }, [subcase]);

  const onOpen = () => {
    const target = SUBSCRIBE_SUBCASES.has(subcase) ? `${WEB_BASE_URL}/claw` : WEB_BASE_URL;
    void Linking.openURL(target);
  };

  return (
    <View className="w-full flex-1 items-center justify-center gap-6 px-6">
      <View
        className={cn(
          'h-24 w-24 items-center justify-center rounded-3xl border',
          tint.tileBgClass,
          tint.tileBorderClass
        )}
      >
        <Icon size={40} color={iconColor} />
      </View>
      <View className="items-center gap-2">
        <Text className="text-center text-2xl font-semibold">{content.title}</Text>
        <Text variant="muted" className="text-center text-base">
          {content.body}
        </Text>
      </View>
      <Button
        variant={content.ctaVariant}
        size="lg"
        className="w-full"
        onPress={onOpen}
        accessibilityRole="link"
      >
        <Text className="text-base">{content.ctaLabel}</Text>
        <ExternalLink size={16} color={ctaIconColor} />
      </Button>
    </View>
  );
}
