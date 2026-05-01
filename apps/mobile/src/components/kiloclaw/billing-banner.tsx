import { AlertTriangle, Clock, Info, type LucideIcon } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import { toneColor, type ToneKey } from '@/lib/agent-color';
import {
  type ClawBillingStatus,
  deriveBannerState,
  formatBillingDate,
} from '@/lib/hooks/use-kiloclaw-billing';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

type Severity = 'info' | 'warn' | 'danger';

// 'info' has no dedicated tone token yet — map to warn (amber). If a
// true neutral-info tone is needed later, add a token pair in global.css.
const SEVERITY_TO_TONE: Record<Severity, ToneKey> = {
  info: 'warn',
  warn: 'warn',
  danger: 'danger',
};

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
        message: `Trial: ${String(billing.trial?.daysRemaining ?? 0)} days remaining`,
        severity: 'info',
      };
    }
    case 'trial_ending_soon':
    case 'trial_ending_very_soon': {
      return {
        icon: Clock,
        message: `Trial ending soon: ${String(billing.trial?.daysRemaining ?? 0)} day${billing.trial?.daysRemaining === 1 ? '' : 's'} left`,
        severity: 'warn',
      };
    }
    case 'trial_expires_today': {
      return {
        icon: AlertTriangle,
        message: 'Trial expires today',
        severity: 'danger',
      };
    }
    case 'earlybird_active': {
      return {
        icon: Info,
        message: billing.earlybird
          ? `Earlybird access until ${formatBillingDate(billing.earlybird.expiresAt)}`
          : '',
        severity: 'info',
      };
    }
    case 'earlybird_ending_soon': {
      return {
        icon: Clock,
        message: `Earlybird ending: ${String(billing.earlybird?.daysRemaining ?? 0)} days left`,
        severity: 'warn',
      };
    }
    case 'subscription_canceling': {
      return {
        icon: AlertTriangle,
        message: billing.subscription
          ? `Subscription cancels ${formatBillingDate(billing.subscription.currentPeriodEnd)}`
          : '',
        severity: 'danger',
      };
    }
    case 'subscription_past_due': {
      return {
        icon: AlertTriangle,
        message: 'Payment past due — please update your payment method',
        severity: 'danger',
      };
    }
    default: {
      return undefined;
    }
  }
}
