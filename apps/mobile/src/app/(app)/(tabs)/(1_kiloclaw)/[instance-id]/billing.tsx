import { ExternalLink } from 'lucide-react-native';
import { Linking, ScrollView, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';

import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { useKiloClawBillingStatus } from '@/lib/hooks/use-kiloclaw';
import { formatBillingDate } from '@/lib/hooks/use-kiloclaw-billing';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

function DetailRow({
  label,
  value,
  valueClassName,
}: Readonly<{ label: string; value: string; valueClassName?: string }>) {
  return (
    <View className="flex-row items-center justify-between py-2">
      <Text variant="muted" className="text-sm">
        {label}
      </Text>
      <Text className={cn('text-sm font-medium', valueClassName)}>{value}</Text>
    </View>
  );
}

function PlanDetails({
  billing,
}: Readonly<{
  billing: NonNullable<ReturnType<typeof useKiloClawBillingStatus>['data']>;
}>) {
  if (billing.subscription) {
    const planName =
      billing.subscription.plan.charAt(0).toUpperCase() + billing.subscription.plan.slice(1);
    return (
      <View>
        <DetailRow label="Plan" value={planName} />
        <View className="h-px bg-border" />
        <DetailRow
          label="Renews"
          value={formatBillingDate(billing.subscription.currentPeriodEnd)}
        />
        {billing.subscription.cancelAtPeriodEnd && (
          <>
            <View className="h-px bg-border" />
            <DetailRow
              label="Status"
              value="Cancels at period end"
              valueClassName="text-destructive"
            />
          </>
        )}
      </View>
    );
  }
  if (billing.trial && !billing.trial.expired) {
    const daysText = `${String(billing.trial.daysRemaining)} day${billing.trial.daysRemaining === 1 ? '' : 's'} left`;
    return (
      <View>
        <DetailRow label="Plan" value="Free Trial" />
        <View className="h-px bg-border" />
        <DetailRow label="Remaining" value={daysText} />
        <View className="h-px bg-border" />
        <DetailRow label="Ends" value={formatBillingDate(billing.trial.endsAt)} />
      </View>
    );
  }
  if (billing.earlybird) {
    const daysText = `${String(billing.earlybird.daysRemaining)} day${billing.earlybird.daysRemaining === 1 ? '' : 's'} left`;
    return (
      <View>
        <DetailRow label="Plan" value="Earlybird" />
        <View className="h-px bg-border" />
        <DetailRow label="Remaining" value={daysText} />
        <View className="h-px bg-border" />
        <DetailRow label="Expires" value={formatBillingDate(billing.earlybird.expiresAt)} />
      </View>
    );
  }
  return (
    <View className="py-2">
      <Text variant="muted" className="text-sm">
        No active plan
      </Text>
    </View>
  );
}

export default function BillingScreen() {
  const colors = useThemeColors();
  const billingQuery = useKiloClawBillingStatus();
  const billing = billingQuery.data;

  if (billingQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Billing" />
        <Animated.View layout={LinearTransition} className="flex-1 px-4 pt-4 gap-3">
          <Animated.View exiting={FadeOut.duration(150)}>
            <Skeleton className="h-24 w-full rounded-lg" />
          </Animated.View>
        </Animated.View>
      </View>
    );
  }

  if (billingQuery.isError || !billing) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Billing" />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message="Could not load billing information"
            onRetry={() => {
              void billingQuery.refetch();
            }}
          />
        </View>
      </View>
    );
  }

  return (
    <Animated.View layout={LinearTransition} className="flex-1 bg-background">
      <ScreenHeader title="Billing" />
      <ScrollView contentContainerClassName="gap-4 px-4 py-4" showsVerticalScrollIndicator={false}>
        <Animated.View entering={FadeIn.duration(200)} className="gap-4">
          {/* Plan details */}
          <View className="bg-secondary rounded-lg px-4">
            <PlanDetails billing={billing} />
          </View>

          {/* Manage billing button */}
          <Button
            variant="outline"
            onPress={() => {
              void Linking.openURL(`${WEB_BASE_URL}/claw`);
            }}
            className="flex-row gap-2"
          >
            <ExternalLink size={16} color={colors.foreground} />
            <Text className="font-medium">Manage Billing on Web</Text>
          </Button>
        </Animated.View>
      </ScrollView>
    </Animated.View>
  );
}
