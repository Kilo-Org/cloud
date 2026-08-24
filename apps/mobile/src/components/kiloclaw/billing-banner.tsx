import { AlertTriangle, Clock, Info, type LucideIcon } from '@/components/ui/icons';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { toneColor, type ToneKey } from '@/lib/agent-color';
import {
  type ClawBillingStatus,
  deriveBannerState,
  formatBillingDate,
  formatRemainingDays,
} from '@/lib/hooks/use-kiloclaw-billing';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type Severity = 'info' | 'warn' | 'danger';

// 'info' has no dedicated tone token yet — map to warn (amber). If a
// true neutral-info tone is needed later, add a token pair in global.css.
const SEVERITY_TO_TONE = {
  info: 'warn',
  warn: 'warn',
  danger: 'danger',
} satisfies Record<Severity, ToneKey>;

type BannerConfig = {
  icon: LucideIcon;
  message: string;
  severity: Severity;
};

export function BillingBanner({ billing }: Readonly<{ billing: ClawBillingStatus }>) {
  const colors = useThemeColors();
  const state = deriveBannerState(billing);

  if (state === 'subscribed' || state === 'none') {
    return null;
  }

  const config = getBannerConfig(billing, state);
  if (!config) {
    return null;
  }

  const Icon = config.icon;
  const tint = toneColor(SEVERITY_TO_TONE[config.severity]);
  const iconColor = colors[tint.hueThemeKey];

  return (
    <View className="flex-row items-center gap-3 rounded-2xl border border-border bg-card p-3">
      <View
        className={`h-9 w-9 items-center justify-center rounded-lg border ${tint.tileBgClass} ${tint.tileBorderClass}`}
      >
        <Icon size={16} color={iconColor} />
      </View>
      <Text className="flex-1 text-[13px] font-medium text-foreground">{config.message}</Text>
    </View>
  );
}

function getBannerConfig(billing: ClawBillingStatus, state: string): BannerConfig | undefined {
  switch (state) {
    case 'trial_active': {
      return {
        icon: Info,
        message: i18n.t('kiloclaw.billing.trialDaysRemaining', {
          days: billing.trial?.daysRemaining ?? 0,
        }),
        severity: 'info',
      };
    }
    case 'trial_ending_soon':
    case 'trial_ending_very_soon': {
      return {
        icon: Clock,
        message: i18n.t('kiloclaw.billing.trialEndingSoon', {
          days: formatRemainingDays(billing.trial?.daysRemaining ?? 0),
        }),
        severity: 'warn',
      };
    }
    case 'earlybird_active': {
      return {
        icon: Info,
        message: billing.earlybird
          ? i18n.t('kiloclaw.billing.earlybirdAccessUntil', {
              date: formatBillingDate(billing.earlybird.expiresAt),
            })
          : '',
        severity: 'info',
      };
    }
    case 'earlybird_ending_soon': {
      return {
        icon: Clock,
        message: i18n.t('kiloclaw.billing.earlybirdEnding', {
          days: billing.earlybird?.daysRemaining ?? 0,
        }),
        severity: 'warn',
      };
    }
    case 'subscription_canceling': {
      return {
        icon: AlertTriangle,
        message: billing.subscription
          ? i18n.t('kiloclaw.billing.subscriptionCancels', {
              date: formatBillingDate(billing.subscription.currentPeriodEnd),
            })
          : '',
        severity: 'danger',
      };
    }
    case 'subscription_past_due': {
      return {
        icon: AlertTriangle,
        message: i18n.t('kiloclaw.billing.paymentPastDue'),
        severity: 'danger',
      };
    }
    default: {
      return undefined;
    }
  }
}
