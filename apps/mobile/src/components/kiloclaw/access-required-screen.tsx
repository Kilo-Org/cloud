import {
  AlertTriangle,
  Clock,
  ExternalLink,
  LifeBuoy,
  type LucideIcon,
  PauseCircle,
  ShieldAlert,
} from '@/components/ui/icons';
import { useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Linking, Platform, View } from 'react-native';

import { Button, type ButtonProps } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { toneColor, type ToneKey } from '@/lib/agent-color';
import {
  ACCESS_REQUIRED_SHOWN_EVENT,
  type AccessRequiredSubcase,
} from '@/lib/analytics/onboarding-events';
import { trackEvent } from '@/lib/appsflyer';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { resolveAccessIssueUrl } from '@/lib/kiloclaw/access-issue';
import { cn } from '@/lib/utils';

export type { AccessRequiredSubcase };

type CtaVariant = Extract<ButtonProps['variant'], 'default' | 'outline'>;

type SubcaseContent = {
  bodyKey: string;
  ctaLabelKey: string;
  ctaVariant: CtaVariant;
  icon: LucideIcon;
  titleKey: string;
  tone: ToneKey;
};

const SUBCASE_CONTENT = {
  trial_expired: {
    bodyKey: 'kiloclaw.accessRequired.trialExpiredBody',
    ctaLabelKey: 'kiloclaw.accessRequired.trialExpiredCta',
    ctaVariant: 'default',
    icon: Clock,
    titleKey: 'kiloclaw.accessRequired.trialExpiredTitle',
    tone: 'warn',
  },
  subscription_canceled: {
    bodyKey: 'kiloclaw.accessRequired.subscriptionCanceledBody',
    ctaLabelKey: 'kiloclaw.accessRequired.subscriptionCanceledCta',
    ctaVariant: 'default',
    icon: PauseCircle,
    titleKey: 'kiloclaw.accessRequired.subscriptionCanceledTitle',
    tone: 'warn',
  },
  subscription_past_due: {
    bodyKey: 'kiloclaw.accessRequired.subscriptionPastDueBody',
    ctaLabelKey: 'kiloclaw.accessRequired.subscriptionPastDueCta',
    ctaVariant: 'default',
    icon: AlertTriangle,
    titleKey: 'kiloclaw.accessRequired.subscriptionPastDueTitle',
    tone: 'danger',
  },
  quarantined: {
    bodyKey: 'kiloclaw.accessRequired.quarantinedBody',
    ctaLabelKey: 'kiloclaw.accessRequired.quarantinedCta',
    ctaVariant: 'outline',
    icon: ShieldAlert,
    titleKey: 'kiloclaw.accessRequired.quarantinedTitle',
    tone: 'danger',
  },
  multiple_current_conflict: {
    bodyKey: 'kiloclaw.accessRequired.multipleCurrentConflictBody',
    ctaLabelKey: 'kiloclaw.accessRequired.multipleCurrentConflictCta',
    ctaVariant: 'outline',
    icon: AlertTriangle,
    titleKey: 'kiloclaw.accessRequired.multipleCurrentConflictTitle',
    tone: 'warn',
  },
  non_canonical_earlybird: {
    bodyKey: 'kiloclaw.accessRequired.nonCanonicalEarlybirdBody',
    ctaLabelKey: 'kiloclaw.accessRequired.nonCanonicalEarlybirdCta',
    ctaVariant: 'outline',
    icon: LifeBuoy,
    titleKey: 'kiloclaw.accessRequired.nonCanonicalEarlybirdTitle',
    tone: 'warn',
  },
} as const satisfies Record<AccessRequiredSubcase, SubcaseContent>;

type AccessRequiredScreenProps = {
  subcase: AccessRequiredSubcase;
};

export function AccessRequiredScreen({ subcase }: Readonly<AccessRequiredScreenProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
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
    void Linking.openURL(resolveAccessIssueUrl(subcase));
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
          <Text className="text-center text-2xl font-semibold">
            {t('kiloclaw.accessRequired.iosTitle')}
          </Text>
          <Text variant="muted" className="text-center text-base">
            {t('kiloclaw.accessRequired.iosBody')}
          </Text>
          <Text variant="muted" className="text-center text-base">
            {t('kiloclaw.accessRequired.iosContact')}
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
        <Text className="text-center text-2xl font-semibold">{t(content.titleKey)}</Text>
        <Text variant="muted" className="text-center text-base">
          {t(content.bodyKey)}
        </Text>
      </View>
      <Button
        variant={content.ctaVariant}
        size="lg"
        className="w-full"
        onPress={onOpen}
        accessibilityRole="link"
      >
        <Text className="text-base">{t(content.ctaLabelKey)}</Text>
        <ExternalLink size={16} color={ctaIconColor} />
      </Button>
    </View>
  );
}
