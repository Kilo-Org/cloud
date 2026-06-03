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

import { Button } from '@/components/ui/button';
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

import {
  getAccessRequiredOpenUrl,
  getAccessRequiredPresentation,
} from './access-required-presentation';

export type { AccessRequiredSubcase };

type SubcaseVisual = {
  icon: LucideIcon;
  tone: ToneKey;
};

const SUBCASE_VISUAL: Record<AccessRequiredSubcase, SubcaseVisual> = {
  trial_expired: {
    icon: Clock,
    tone: 'warn',
  },
  subscription_canceled: {
    icon: PauseCircle,
    tone: 'warn',
  },
  subscription_past_due: {
    icon: AlertTriangle,
    tone: 'danger',
  },
  quarantined: {
    icon: ShieldAlert,
    tone: 'danger',
  },
  multiple_current_conflict: {
    icon: AlertTriangle,
    tone: 'warn',
  },
  non_canonical_earlybird: {
    icon: LifeBuoy,
    tone: 'warn',
  },
};

type AccessRequiredScreenProps = {
  subcase: AccessRequiredSubcase;
};

export function AccessRequiredScreen({ subcase }: Readonly<AccessRequiredScreenProps>) {
  const colors = useThemeColors();
  const presentation = getAccessRequiredPresentation(subcase, Platform.OS);
  const visual = SUBCASE_VISUAL[subcase];
  const Icon = visual.icon;
  const tint = toneColor(visual.tone);
  const iconColor = colors[tint.hueThemeKey];
  const ctaIconColor =
    presentation.ctaVariant === 'default' ? colors.primaryForeground : colors.foreground;

  const trackedSubcaseRef = useRef<AccessRequiredSubcase | null>(null);
  useEffect(() => {
    if (trackedSubcaseRef.current === subcase) {
      return;
    }
    trackedSubcaseRef.current = subcase;
    trackEvent(ACCESS_REQUIRED_SHOWN_EVENT, { subcase });
  }, [subcase]);

  const onOpen = () => {
    void Linking.openURL(getAccessRequiredOpenUrl(subcase, WEB_BASE_URL));
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
        <Text className="text-center text-2xl font-semibold">{presentation.title}</Text>
        <Text variant="muted" className="text-center text-base">
          {presentation.body}
        </Text>
      </View>
      {presentation.ctaLabel !== null && presentation.ctaVariant !== null ? (
        <Button
          variant={presentation.ctaVariant}
          size="lg"
          className="w-full"
          onPress={onOpen}
          accessibilityRole="link"
        >
          <Text className="text-base">{presentation.ctaLabel}</Text>
          <ExternalLink size={16} color={ctaIconColor} />
        </Button>
      ) : null}
    </View>
  );
}
