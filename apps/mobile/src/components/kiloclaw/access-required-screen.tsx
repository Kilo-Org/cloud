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
import { Linking, Platform, View } from 'react-native';

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

export type { AccessRequiredSubcase };

type CtaVariant = Extract<ButtonProps['variant'], 'default' | 'outline'>;

type SubcaseContent = {
  body: string;
  ctaLabel: string;
  ctaVariant: CtaVariant;
  icon: LucideIcon;
  title: string;
  tone: ToneKey;
};

const SUBCASE_CONTENT: Record<AccessRequiredSubcase, SubcaseContent> = {
  trial_expired: {
    body: "To keep using KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
    icon: Clock,
    title: 'Subscribe on the web',
    tone: 'warn',
  },
  subscription_canceled: {
    body: "To use KiloClaw, go to kilo.ai/claw from your browser. You can't subscribe in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
    icon: PauseCircle,
    title: 'Subscribe on the web',
    tone: 'warn',
  },
  subscription_past_due: {
    body: "We had trouble with your most recent payment. Go to kilo.ai/claw from your browser to update it. You can't manage billing in the app.",
    ctaLabel: 'Open kilo.ai/claw',
    ctaVariant: 'default',
    icon: AlertTriangle,
    title: 'Update payment on the web',
    tone: 'danger',
  },
  quarantined: {
    body: "Your KiloClaw instance is in a quarantined state and can't be used right now. Our team needs to help restore it.",
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
    icon: ShieldAlert,
    title: 'Instance needs remediation',
    tone: 'danger',
  },
  multiple_current_conflict: {
    body: "We found more than one active subscription on your account, so we've paused things to avoid double-billing you.",
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
    icon: AlertTriangle,
    title: 'Account needs review',
    tone: 'warn',
  },
  non_canonical_earlybird: {
    body: 'Your early-access plan needs a manual review before it can be used on mobile.',
    ctaLabel: 'Continue on kilo.ai',
    ctaVariant: 'outline',
    icon: LifeBuoy,
    title: 'Legacy plan detected',
    tone: 'warn',
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

  if (Platform.OS === 'ios') {
    const iosTint = toneColor('warn');
    const iosIconColor = colors[iosTint.hueThemeKey];

    return (
      <View className="w-full flex-1 items-center justify-center gap-6 px-6">
        <View
          className={cn(
            'h-24 w-24 items-center justify-center rounded-3xl border',
            iosTint.tileBgClass,
            iosTint.tileBorderClass
          )}
        >
          <AlertTriangle size={40} color={iosIconColor} />
        </View>
        <View className="items-center gap-2">
          <Text className="text-center text-2xl font-semibold">KiloClaw unavailable in iOS</Text>
          <Text variant="muted" className="text-center text-base">
            KiloClaw access is managed outside the iOS app for this account.
          </Text>
        </View>
      </View>
    );
  }

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
