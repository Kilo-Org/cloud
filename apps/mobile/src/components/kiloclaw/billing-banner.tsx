import { AlertTriangle, Clock, Info } from 'lucide-react-native';
import { View } from 'react-native';

import { Text } from '@/components/ui/text';
import {
  type ClawBillingStatus,
  deriveBannerState,
  formatBillingDate,
} from '@/lib/hooks/use-kiloclaw-billing';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';

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

  return (
    <View className={`flex-row items-center gap-3 rounded-lg p-3 ${config.bgClass}`}>
      <Icon size={18} color={colors.foreground} />
      <Text className="flex-1 text-xs font-medium">{config.message}</Text>
    </View>
  );
}

function getBannerConfig(
  billing: ClawBillingStatus,
  state: string
): { icon: typeof Info; message: string; bgClass: string } | undefined {
  switch (state) {
    case 'trial_active': {
      return {
        icon: Info,
        message: `Trial: ${String(billing.trial?.daysRemaining ?? 0)} days remaining`,
        bgClass: 'bg-secondary',
      };
    }
    case 'trial_ending_soon':
    case 'trial_ending_very_soon': {
      return {
        icon: Clock,
        message: `Trial ending soon: ${String(billing.trial?.daysRemaining ?? 0)} day${billing.trial?.daysRemaining === 1 ? '' : 's'} left`,
        bgClass: 'bg-secondary',
      };
    }
    case 'trial_expires_today': {
      return {
        icon: AlertTriangle,
        message: 'Trial expires today',
        bgClass: 'bg-red-100 dark:bg-red-950',
      };
    }
    case 'earlybird_active': {
      return {
        icon: Info,
        message: billing.earlybird
          ? `Earlybird access until ${formatBillingDate(billing.earlybird.expiresAt)}`
          : '',
        bgClass: 'bg-secondary',
      };
    }
    case 'earlybird_ending_soon': {
      return {
        icon: Clock,
        message: `Earlybird ending: ${String(billing.earlybird?.daysRemaining ?? 0)} days left`,
        bgClass: 'bg-secondary',
      };
    }
    case 'subscription_canceling': {
      return {
        icon: AlertTriangle,
        message: billing.subscription
          ? `Subscription cancels ${formatBillingDate(billing.subscription.currentPeriodEnd)}`
          : '',
        bgClass: 'bg-red-100 dark:bg-red-950',
      };
    }
    case 'subscription_past_due': {
      return {
        icon: AlertTriangle,
        message: 'Payment past due — please update your payment method',
        bgClass: 'bg-red-100 dark:bg-red-950',
      };
    }
    default: {
      return undefined;
    }
  }
}
