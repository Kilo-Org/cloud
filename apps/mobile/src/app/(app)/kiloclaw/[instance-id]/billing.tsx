import { formatDollars, fromMicrodollars } from '@kilocode/app-shared/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { CreditCard, ExternalLink } from 'lucide-react-native';
import { Linking, View } from 'react-native';
import Animated, { FadeIn, FadeOut, LinearTransition } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { DetailScreenScrollView } from '@/components/detail-screen';
import { EmptyState } from '@/components/empty-state';
import { InstanceContextBoundary } from '@/components/kiloclaw/instance-context-boundary';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { WEB_BASE_URL } from '@/lib/config';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawBillingStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { formatBillingDate, formatRemainingDays } from '@/lib/hooks/use-kiloclaw-billing';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';
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

function formatStandardPrice(microdollars: number | null | undefined): string {
  return microdollars == null
    ? 'your Standard monthly price'
    : `${formatDollars(fromMicrodollars(microdollars))}/month`;
}

/** "Continue month-to-month" CTA shown during a Commit plan's final term. */
function ContinueMonthToMonthAction({ instanceId }: Readonly<{ instanceId: string }>) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    trpc.kiloclaw.continueCommitAsStandard.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.kiloclaw.getBillingStatus.queryKey(),
        });
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  return (
    <Button
      size="sm"
      loading={mutation.isPending}
      onPress={() => {
        mutation.mutate({ instanceId });
      }}
      className="self-start"
    >
      <Text>Continue month-to-month</Text>
    </Button>
  );
}

function FinalCommitTermDetails({
  billing,
}: Readonly<{
  billing: NonNullable<ReturnType<typeof useKiloClawBillingStatus>['data']>;
}>) {
  const subscription = billing.subscription;
  if (!subscription) {
    return null;
  }
  const finalDate = formatBillingDate(
    subscription.finalCommitEndsAt ?? subscription.currentPeriodEnd
  );
  const priceText = formatStandardPrice(subscription.standardContinuationPriceMicrodollars);
  const instanceId = billing.instance?.id;

  return (
    <View>
      <DetailRow label="Plan" value="Commit" />
      <View className="h-px bg-border" />
      <DetailRow label="Final term ends" value={finalDate} />
      <View className="h-px bg-border" />
      <DetailRow
        label="After final term"
        value={
          subscription.standardContinuationScheduled ? 'Standard month-to-month' : 'Hosting ends'
        }
      />
      <View className="gap-3 py-3">
        <Text variant="muted" className="text-sm">
          {subscription.standardContinuationScheduled
            ? `Standard starts on ${finalDate} at ${priceText}.`
            : `Your final Commit term ends on ${finalDate}. Continue as Standard at ${priceText}, or hosting ends.`}
        </Text>
        {!subscription.standardContinuationScheduled && instanceId ? (
          <ContinueMonthToMonthAction instanceId={instanceId} />
        ) : null}
      </View>
    </View>
  );
}

function PlanDetails({
  billing,
}: Readonly<{
  billing: NonNullable<ReturnType<typeof useKiloClawBillingStatus>['data']>;
}>) {
  if (billing.subscription?.isFinalCommitTerm) {
    return <FinalCommitTermDetails billing={billing} />;
  }
  if (billing.subscription) {
    const planName =
      billing.subscription.plan.charAt(0).toUpperCase() + billing.subscription.plan.slice(1);
    const cancelling = billing.subscription.cancelAtPeriodEnd;
    return (
      <View>
        <DetailRow label="Plan" value={planName} />
        <View className="h-px bg-border" />
        <DetailRow
          label={cancelling ? 'Ends' : 'Renews'}
          value={formatBillingDate(billing.subscription.currentPeriodEnd)}
          valueClassName={cancelling ? 'text-destructive' : undefined}
        />
      </View>
    );
  }
  if (billing.trial && !billing.trial.expired) {
    const daysText = formatRemainingDays(billing.trial.daysRemaining);
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
    <EmptyState
      icon={CreditCard}
      title="No active plan"
      description="You don't have an active KiloClaw subscription."
      placement="top"
      className="py-4"
    />
  );
}

export default function BillingScreen() {
  const { 'instance-id': instanceId } = useLocalSearchParams<{ 'instance-id': string }>();
  const instanceContext = useInstanceContext(instanceId);
  const isOrg = instanceContext.status === 'ready' && instanceContext.isOrg;
  const colors = useThemeColors();

  const billingQuery = useKiloClawBillingStatus(instanceContext.status === 'ready' && !isOrg);
  const billing = billingQuery.data;

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return <InstanceContextBoundary title="Billing" context={instanceContext} />;
  }

  if (isOrg) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Billing" />
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-muted-foreground">
            Billing is managed by your organization admin.
          </Text>
        </View>
      </View>
    );
  }

  if (billingQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title="Billing" />
        <Animated.View layout={LinearTransition} className="flex-1 gap-4 px-4 pt-4">
          <Animated.View exiting={FadeOut.duration(150)} className="gap-4">
            <View className="gap-0 rounded-lg bg-secondary px-4">
              <View className="flex-row items-center justify-between py-2">
                <Skeleton className="h-4 w-12 rounded" />
                <Skeleton className="h-4 w-20 rounded" />
              </View>
              <View className="h-px bg-border" />
              <View className="flex-row items-center justify-between py-2">
                <Skeleton className="h-4 w-16 rounded" />
                <Skeleton className="h-4 w-28 rounded" />
              </View>
              <View className="h-px bg-border" />
              <View className="flex-row items-center justify-between py-2">
                <Skeleton className="h-4 w-14 rounded" />
                <Skeleton className="h-4 w-24 rounded" />
              </View>
            </View>
            <Skeleton className="h-11 w-full rounded-md" />
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
      <DetailScreenScrollView
        contentContainerClassName="gap-4 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
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
      </DetailScreenScrollView>
    </Animated.View>
  );
}
