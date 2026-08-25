import { fromMicrodollars } from '@kilocode/app-shared/utils';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useLocalSearchParams } from 'expo-router';
import { CreditCard, ExternalLink } from '@/components/ui/icons';
import { Linking, View } from 'react-native';
import { useTranslation } from 'react-i18next';
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
import { i18n } from '@/i18n';
import { WEB_BASE_URL } from '@/lib/config';
import { formatMoney } from '@/lib/format';
import { useInstanceContext } from '@/lib/hooks/use-instance-context';
import { useKiloClawBillingStatus } from '@/lib/hooks/use-kiloclaw-queries';
import { formatBillingDate, formatRemainingDays } from '@/lib/hooks/use-kiloclaw-billing';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useTRPC } from '@/lib/trpc';
import { capitalize, cn } from '@/lib/utils';

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
    ? i18n.t('kiloclaw.billing.yourStandardMonthlyPrice')
    : `${formatMoney(fromMicrodollars(microdollars), i18n.language)}${i18n.t('kiloclaw.billing.perMonth')}`;
}

/** "Continue month-to-month" CTA shown during a Commit plan's final term. */
function ContinueMonthToMonthAction({ instanceId }: Readonly<{ instanceId: string }>) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { t } = useTranslation();
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
      <Text>{t('kiloclaw.billing.continueMonthToMonth')}</Text>
    </Button>
  );
}

function FinalCommitTermDetails({
  billing,
}: Readonly<{
  billing: NonNullable<ReturnType<typeof useKiloClawBillingStatus>['data']>;
}>) {
  const { t } = useTranslation();
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
      <DetailRow label={t('kiloclaw.billing.plan')} value={t('kiloclaw.billing.commitPlan')} />
      <View className="h-px bg-border" />
      <DetailRow label={t('kiloclaw.billing.finalTermEnds')} value={finalDate} />
      <View className="h-px bg-border" />
      <DetailRow
        label={t('kiloclaw.billing.afterFinalTerm')}
        value={
          subscription.standardContinuationScheduled
            ? t('kiloclaw.billing.standardMonthToMonth')
            : t('kiloclaw.billing.hostingEnds')
        }
      />
      <View className="gap-3 py-3">
        <Text variant="muted" className="text-sm">
          {subscription.standardContinuationScheduled
            ? t('kiloclaw.billing.standardStartsOn', { date: finalDate, price: priceText })
            : t('kiloclaw.billing.finalCommitTermEndsOn', { date: finalDate, price: priceText })}
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
  const { t } = useTranslation();
  if (billing.subscription?.isFinalCommitTerm) {
    return <FinalCommitTermDetails billing={billing} />;
  }
  if (billing.subscription) {
    const planName = capitalize(billing.subscription.plan);
    const cancelling = billing.subscription.cancelAtPeriodEnd;
    return (
      <View>
        <DetailRow label={t('kiloclaw.billing.plan')} value={planName} />
        <View className="h-px bg-border" />
        <DetailRow
          label={cancelling ? t('kiloclaw.billing.ends') : t('kiloclaw.billing.renews')}
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
        <DetailRow label={t('kiloclaw.billing.plan')} value={t('kiloclaw.billing.freeTrial')} />
        <View className="h-px bg-border" />
        <DetailRow label={t('kiloclaw.billing.remaining')} value={daysText} />
        <View className="h-px bg-border" />
        <DetailRow
          label={t('kiloclaw.billing.ends')}
          value={formatBillingDate(billing.trial.endsAt)}
        />
      </View>
    );
  }
  if (billing.earlybird) {
    const daysText = formatRemainingDays(billing.earlybird.daysRemaining);
    return (
      <View>
        <DetailRow label={t('kiloclaw.billing.plan')} value={t('kiloclaw.billing.earlybird')} />
        <View className="h-px bg-border" />
        <DetailRow label={t('kiloclaw.billing.remaining')} value={daysText} />
        <View className="h-px bg-border" />
        <DetailRow
          label={t('kiloclaw.billing.expires')}
          value={formatBillingDate(billing.earlybird.expiresAt)}
        />
      </View>
    );
  }
  return (
    <EmptyState
      icon={CreditCard}
      title={t('kiloclaw.billing.noActivePlan')}
      description={t('kiloclaw.billing.noActivePlanDescription')}
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
  const { t } = useTranslation();

  const billingQuery = useKiloClawBillingStatus(instanceContext.status === 'ready' && !isOrg);
  const billing = billingQuery.data;

  if (instanceContext.status === 'error' || instanceContext.status === 'not_found') {
    return (
      <InstanceContextBoundary title={t('kiloclaw.billing.title')} context={instanceContext} />
    );
  }

  if (isOrg) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('kiloclaw.billing.title')} />
        <View className="flex-1 items-center justify-center px-6">
          <Text className="text-center text-muted-foreground">
            {t('kiloclaw.billing.managedByAdmin')}
          </Text>
        </View>
      </View>
    );
  }

  if (billingQuery.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('kiloclaw.billing.title')} />
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
        <ScreenHeader title={t('kiloclaw.billing.title')} />
        <View className="flex-1 items-center justify-center">
          <QueryError
            message={t('kiloclaw.billing.couldNotLoad')}
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
      <ScreenHeader title={t('kiloclaw.billing.title')} />
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
            <Text className="font-medium">{t('kiloclaw.billing.manageOnWeb')}</Text>
          </Button>
        </Animated.View>
      </DetailScreenScrollView>
    </Animated.View>
  );
}
