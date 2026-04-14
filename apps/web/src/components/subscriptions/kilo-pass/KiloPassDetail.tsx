'use client';

import { useCallback, useMemo, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { AlertTriangle, Calendar, Coins, Crown, ExternalLink, Loader2 } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { cn } from '@/lib/utils';
import { useRawTRPCClient, useTRPC } from '@/lib/trpc/utils';
import { formatDollars, formatIsoDateString_UsaDateOnlyFormat } from '@/lib/utils';
import { DetailPageHeader } from '@/components/subscriptions/DetailPageHeader';
import { BillingHistoryTable } from '@/components/subscriptions/BillingHistoryTable';
import { CreditHistory } from './CreditHistory';
import {
  KiloPassSubscriptionInfoProvider,
  useKiloPassSubscriptionInfo,
} from '@/components/profile/kilo-pass/useKiloPassSubscriptionInfo';
import { useKiloPassChurnkeyCancelFlow } from '@/components/profile/kilo-pass/useKiloPassChurnkeyCancelFlow';
import type { KiloPassSubscription } from '@/components/profile/kilo-pass/kiloPassSubscription';
import { KiloPassSubscriptionSettingsModal } from '@/components/profile/kilo-pass/KiloPassSubscriptionSettingsModal';
import { KiloPassBonusRampDialog } from '@/components/profile/kilo-pass/KiloPassBonusRampDialog';
import { computeMonthlyCadenceBonusPercent } from '@/lib/kilo-pass/bonus';
import { KiloPassCadence } from '@/lib/kilo-pass/enums';
import { KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT } from '@/lib/kilo-pass/constants';
import {
  computeUsageProgressModel,
  computeRenewInfoRowModel,
} from '@/components/profile/kilo-pass/KiloPassActiveSubscriptionCard.logic';
import {
  formatKiloPassCadenceLabel,
  formatKiloPassPrice,
  formatKiloPassTierLabel,
  formatMonthCountLabel,
  isKiloPassTerminal,
} from '@/components/subscriptions/helpers';
import { useCursorPagination } from '@/components/subscriptions/useCursorPagination';
import {
  getKiloPassSubscriptionDisplayModel,
  getKiloPassInlineActionModel,
  getKiloPassInlineConfirmationDetails,
} from './KiloPassDetail.logic';
import type {
  KiloPassInlineConfirmationAction,
  KiloPassInlinePrimaryAction,
} from './KiloPassDetail.logic';

export function KiloPassDetail() {
  const trpc = useTRPC();
  const trpcClient = useRawTRPCClient();
  const queryClient = useQueryClient();
  const [settingsOpen, setSettingsOpen] = useState(false);

  const stateQuery = useQuery(trpc.kiloPass.getState.queryOptions());
  const scheduledChangeQuery = useQuery(trpc.kiloPass.getScheduledChange.queryOptions());
  const billingQuery = useQuery(trpc.kiloPass.getBillingHistory.queryOptions({}));
  const creditHistoryQuery = useQuery(trpc.kiloPass.getCreditHistory.queryOptions({}));

  const subscriptionId = stateQuery.data?.subscription?.stripeSubscriptionId ?? null;

  const fetchMoreBilling = useCallback(
    (cursor: string) => trpcClient.kiloPass.getBillingHistory.query({ cursor }),
    [trpcClient]
  );
  const billing = useCursorPagination({
    initialData: billingQuery.data,
    fetchMore: fetchMoreBilling,
    resetKey: subscriptionId,
  });

  const fetchMoreCredits = useCallback(
    (cursor: string) => trpcClient.kiloPass.getCreditHistory.query({ cursor }),
    [trpcClient]
  );
  const credits = useCursorPagination({
    initialData: creditHistoryQuery.data,
    fetchMore: fetchMoreCredits,
    resetKey: subscriptionId,
  });

  const subscription = stateQuery.data?.subscription ?? null;
  const scheduledChange = scheduledChangeQuery.data?.scheduledChange ?? null;

  const showFirstMonthPromoInDialog = useMemo(() => {
    if (!subscription || subscription.cadence !== 'monthly') return false;
    const promoPercent = computeMonthlyCadenceBonusPercent({
      tier: subscription.tier,
      streakMonths: Math.max(1, subscription.currentStreakMonths),
      isFirstTimeSubscriberEver: subscription.isFirstTimeSubscriberEver,
      subscriptionStartedAtIso: subscription.startedAt,
    });
    return promoPercent === KILO_PASS_FIRST_MONTH_PROMO_BONUS_PERCENT;
  }, [subscription]);

  async function refreshData() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getScheduledChange.queryKey() }),
      queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getBillingHistory.queryKey({}) }),
      queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getCreditHistory.queryKey({}) }),
    ]);
  }

  async function handleResume() {
    await trpcClient.kiloPass.resumeCancelledSubscription.mutate();
    toast.success('Subscription resumed');
    await refreshData();
  }

  async function handleResumePaused() {
    await trpcClient.kiloPass.resumePausedSubscription.mutate();
    toast.success('Subscription resumed');
    await refreshData();
  }

  async function handleCancelScheduledChange() {
    await trpcClient.kiloPass.cancelScheduledChange.mutate();
    toast.success('Scheduled change canceled');
    await refreshData();
  }

  if (stateQuery.isLoading) {
    return (
      <Card>
        <CardContent className="p-6">Loading subscription...</CardContent>
      </Card>
    );
  }

  if (!subscription) {
    return (
      <Card>
        <CardContent className="p-6">Kilo Pass subscription not found.</CardContent>
      </Card>
    );
  }

  const nextBillingDateLabel = formatIsoDateString_UsaDateOnlyFormat(subscription.nextBillingAt);
  const resumesAtLabel = formatIsoDateString_UsaDateOnlyFormat(subscription.resumesAt);
  const subscriptionDisplay = getKiloPassSubscriptionDisplayModel({
    status: subscription.status,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    nextBillingLabel: nextBillingDateLabel,
    resumesAtLabel,
  });

  return (
    <KiloPassSubscriptionInfoProvider subscription={subscription}>
      <div className="space-y-6">
        <DetailPageHeader
          backHref="/subscriptions"
          backLabel="Back to subscriptions"
          title="Kilo Pass"
          status={subscriptionDisplay.status}
        />

        {subscriptionDisplay.detailAlert ? (
          <Alert variant="warning">
            <AlertTriangle />
            <AlertTitle>{subscriptionDisplay.detailAlert.title}</AlertTitle>
            <AlertDescription>
              <p>{subscriptionDisplay.detailAlert.description}</p>
            </AlertDescription>
          </Alert>
        ) : null}

        <div className="grid items-stretch gap-6 xl:grid-cols-2">
          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <Coins className="h-5 w-5" />
                Subscription details
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <DetailRow label="Tier" value={formatKiloPassTierLabel(subscription.tier)} />
                <DetailRow
                  label="Cadence"
                  value={formatKiloPassCadenceLabel(subscription.cadence)}
                />
                <DetailRow
                  label="Price"
                  value={formatKiloPassPrice(subscription.tier, subscription.cadence)}
                />
                <DetailRow
                  label={subscriptionDisplay.detailDateLabel}
                  value={subscriptionDisplay.detailDateValue}
                />
                <DetailRow
                  label="Started"
                  value={formatIsoDateString_UsaDateOnlyFormat(subscription.startedAt)}
                />
                <DetailRow
                  label="Current streak"
                  value={formatMonthCountLabel(subscription.currentStreakMonths)}
                />
              </div>

              {scheduledChange ? (
                <Card className="border-blue-500/30 bg-blue-500/5">
                  <CardContent className="flex flex-col gap-3 p-4 sm:flex-row sm:items-center sm:justify-between">
                    <div>
                      <p className="font-medium">Scheduled change</p>
                      <p className="text-muted-foreground text-sm">
                        {formatKiloPassTierLabel(scheduledChange.toTier)}{' '}
                        {formatKiloPassCadenceLabel(scheduledChange.toCadence)} on{' '}
                        {formatIsoDateString_UsaDateOnlyFormat(scheduledChange.effectiveAt)}
                      </p>
                    </div>
                    <Button variant="outline" onClick={() => void handleCancelScheduledChange()}>
                      Cancel Scheduled Change
                    </Button>
                  </CardContent>
                </Card>
              ) : null}
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="pb-4">
              <CardTitle className="flex items-center gap-2">
                <Crown className="h-5 w-5" />
                Bonus streak
                <KiloPassBonusRampDialog
                  tier={subscription.tier}
                  showFirstMonthPromo={showFirstMonthPromoInDialog}
                  showSecondMonthPromo={subscription.currentStreakMonths === 1}
                  streakMonths={subscription.currentStreakMonths}
                  subscriptionStartedAtIso={subscription.startedAt ?? undefined}
                />
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <BonusStreakContent subscription={subscription} />
            </CardContent>
          </Card>
        </div>

        {isKiloPassTerminal(subscription.status) ? null : (
          <KiloPassInlineActions
            onOpenSettings={() => setSettingsOpen(true)}
            onResume={handleResume}
            onResumePaused={handleResumePaused}
            hasScheduledChange={Boolean(scheduledChange)}
          />
        )}

        <Card>
          <CardHeader className="pb-4">
            <CardTitle>Credit history</CardTitle>
          </CardHeader>
          <CardContent className="pt-1">
            <CreditHistory
              entries={credits.entries}
              hasMore={credits.hasMore}
              onLoadMore={() => void credits.loadMore()}
              isLoading={credits.isLoadingMore}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-4">
            <CardTitle>Billing history</CardTitle>
          </CardHeader>
          <CardContent className="pt-1">
            <BillingHistoryTable
              variant="stripe"
              entries={billing.entries}
              hasMore={billing.hasMore}
              onLoadMore={() => void billing.loadMore()}
              isLoading={billing.isLoadingMore}
            />
          </CardContent>
        </Card>

        <KiloPassSubscriptionSettingsModal
          isOpen={settingsOpen}
          onClose={() => setSettingsOpen(false)}
        />
      </div>
    </KiloPassSubscriptionInfoProvider>
  );
}

function KiloPassInlineActions({
  onOpenSettings,
  onResume,
  onResumePaused,
  hasScheduledChange,
}: {
  onOpenSettings: () => void;
  onResume: () => Promise<void>;
  onResumePaused: () => Promise<void>;
  hasScheduledChange: boolean;
}) {
  const { subscription, view, actions } = useKiloPassSubscriptionInfo();
  const { openCancelFlow, isOpeningCancelFlow } = useKiloPassChurnkeyCancelFlow({
    stripeSubscriptionId: subscription.stripeSubscriptionId,
    fallbackCancelSubscription: actions.cancelSubscription,
  });
  const [confirmationAction, setConfirmationAction] =
    useState<KiloPassInlineConfirmationAction | null>(null);
  const [pendingAction, setPendingAction] = useState<KiloPassInlineConfirmationAction | null>(null);

  const primaryAction: KiloPassInlinePrimaryAction = view.actions.resumePaused
    ? 'resumePaused'
    : view.actions.resume
      ? 'resume'
      : view.actions.cancel
        ? 'cancel'
        : 'none';

  const inlineActionModel = getKiloPassInlineActionModel({
    hasScheduledChange,
    primaryAction,
    isResumingSubscription: actions.isResumingSubscription,
    isOpeningCancelFlow,
    isCancelingSubscription: actions.isCancelingSubscription,
  });

  const confirmationDetails = getKiloPassInlineConfirmationDetails({
    confirmationAction,
    onResume,
    onResumePaused,
  });

  function confirmAction() {
    if (!confirmationAction || !confirmationDetails) return;
    setPendingAction(confirmationAction);
    void confirmationDetails
      .action()
      .then(() => setConfirmationAction(null))
      .catch(() => {})
      .finally(() => setPendingAction(null));
  }

  return (
    <>
      <div className="flex flex-wrap gap-2">
        <Button
          variant="outline"
          onClick={onOpenSettings}
          disabled={inlineActionModel.changePlanDisabled}
        >
          Change Plan
        </Button>
        {inlineActionModel.resumePaused ? (
          <Button
            variant="outline"
            onClick={() => setConfirmationAction('resumePaused')}
            disabled={inlineActionModel.resumePaused.disabled}
          >
            Resume Subscription
          </Button>
        ) : inlineActionModel.resume ? (
          <Button
            variant="outline"
            onClick={() => setConfirmationAction('resume')}
            disabled={inlineActionModel.resume.disabled}
          >
            Resume Subscription
          </Button>
        ) : inlineActionModel.cancel ? (
          <Button
            variant="outline"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive gap-2"
            onClick={() => void openCancelFlow()}
            disabled={inlineActionModel.cancel.disabled}
          >
            {inlineActionModel.cancel.isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : null}
            {inlineActionModel.cancel.label}
          </Button>
        ) : null}
        <Button
          variant="outline"
          onClick={actions.openCustomerPortal}
          disabled={actions.isOpeningCustomerPortal}
        >
          <ExternalLink className="h-4 w-4" />
          {actions.isOpeningCustomerPortal ? 'Opening...' : 'Manage Payment Method'}
        </Button>
      </div>

      <AlertDialog
        open={confirmationAction !== null}
        onOpenChange={open => {
          if (!open && pendingAction === null) {
            setConfirmationAction(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{confirmationDetails?.title}</AlertDialogTitle>
            <AlertDialogDescription>{confirmationDetails?.description}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={pendingAction !== null}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={confirmationDetails?.confirmVariant ?? 'default'}
              onClick={confirmAction}
              disabled={pendingAction !== null}
            >
              {pendingAction !== null
                ? confirmationDetails?.pendingLabel
                : confirmationDetails?.confirmLabel}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function BonusStreakContent({ subscription }: { subscription: KiloPassSubscription }) {
  const trpc = useTRPC();
  const scheduledChangeQuery = useQuery(trpc.kiloPass.getScheduledChange.queryOptions());
  const scheduledChange = scheduledChangeQuery.data?.scheduledChange ?? null;
  const { view } = useKiloPassSubscriptionInfo();

  const model = computeUsageProgressModel({
    baseUsd: subscription.currentPeriodBaseCreditsUsd,
    usageUsd: subscription.currentPeriodUsageUsd,
    bonusUsd: subscription.currentPeriodBonusCreditsUsd,
    isBonusUnlocked: subscription.isBonusUnlocked,
  });

  const renewRows = computeRenewInfoRowModel({
    subscription,
    isPendingCancellation: Boolean(view.pendingCancellation),
    isPaused: subscription.status === 'paused',
    resumesAtIso: subscription.resumesAt,
    scheduledChange,
  });

  const expiresAt =
    subscription.status === 'paused'
      ? subscription.resumesAt
      : (subscription.refillAt ?? subscription.nextBillingAt);
  const expiresAtLabel = expiresAt ? formatIsoDateString_UsaDateOnlyFormat(expiresAt) : null;

  return (
    <div className="space-y-4">
      {model ? (
        <div className="bg-muted/20 border-border/60 grid gap-3 rounded-lg border p-3">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">This month&apos;s usage</span>
            <span className={cn('font-mono font-semibold', model.statusClass)}>
              {formatDollars(model.nonNegativeUsageUsd)} / {formatDollars(model.totalAvailableUsd)}
            </span>
          </div>

          <div className="space-y-2">
            <div className="bg-muted/50 relative h-3 overflow-visible rounded-full">
              <div
                className="absolute inset-y-0 left-0 opacity-40"
                style={{
                  width: `${model.pctOfBaseInTotal}%`,
                  background: 'rgba(245,158,11,0.20)',
                }}
              />
              <div
                className="absolute inset-y-0 opacity-40"
                style={{
                  left: `${model.pctOfBaseInTotal}%`,
                  width: `${100 - model.pctOfBaseInTotal}%`,
                  background: 'rgba(16,185,129,0.20)',
                }}
              />
              <div
                className="absolute inset-y-0 left-0 rounded-l-full bg-linear-to-r from-amber-500 to-amber-300 transition-[width]"
                style={{ width: `${model.paidFillPct}%` }}
              />
              <div
                className="absolute inset-y-0 rounded-r-full bg-linear-to-r from-emerald-500 to-emerald-300 transition-[width]"
                style={{ left: `${model.pctOfBaseInTotal}%`, width: `${model.bonusFillPct}%` }}
              />
              <div
                className="absolute top-full mt-0.5 h-1.5 w-0.5 rounded bg-white/40"
                style={{ left: `calc(${model.pctOfBaseInTotal}% - 1px)` }}
              />
            </div>

            <div className="relative h-4">
              <span
                className="absolute -translate-x-1/2 font-mono text-xs font-semibold text-amber-300"
                style={{ left: `${model.pctOfBaseInTotal}%` }}
              >
                {formatDollars(model.baseUsd)}
              </span>
              <span className="absolute right-0 font-mono text-xs font-semibold text-emerald-300">
                {formatDollars(model.bonusUsd)}
              </span>
            </div>

            <div className="text-muted-foreground flex items-center justify-between text-xs">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-sm bg-amber-400/80" />
                Paid
              </div>
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-sm bg-emerald-400/80" />
                Free bonus
              </div>
            </div>
          </div>
        </div>
      ) : null}

      {renewRows.map(row => {
        if (row.kind === 'paused_until') {
          const dateLabel = formatIsoDateString_UsaDateOnlyFormat(row.resumesAtIso);
          return (
            <div
              key={`paused_until:${row.resumesAtIso}`}
              className="bg-muted/20 border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
            >
              <div className="flex items-start gap-2">
                <Calendar className="mt-0.5 h-4 w-4 text-white/40" />
                <div className="text-muted-foreground">Paused until</div>
              </div>
              <span className="text-muted-foreground">{dateLabel}</span>
            </div>
          );
        }

        const dateLabel = formatIsoDateString_UsaDateOnlyFormat(row.refillAtIso);

        if (row.kind === 'active_until') {
          return (
            <div
              key={`active_until:${row.refillAtIso}`}
              className="bg-muted/20 border-border/60 flex items-center justify-between gap-3 rounded-lg border px-3 py-2 text-sm"
            >
              <div className="flex items-start gap-2">
                <Calendar className="mt-0.5 h-4 w-4 text-white/40" />
                <div className="text-muted-foreground">Active until</div>
              </div>
              <span className="text-muted-foreground">{dateLabel}</span>
            </div>
          );
        }

        return (
          <div
            key={`renews_and_adds_bonus:${row.refillAtIso}`}
            className="bg-muted/20 border-border/60 rounded-lg border px-3 py-2 text-sm"
          >
            <div className="flex items-start gap-2">
              <Calendar className="mt-0.5 h-4 w-4 text-white/40" />
              <div className="text-muted-foreground">
                <div>
                  {row.labelPrefix}: <span className="text-foreground">{dateLabel}</span>
                </div>
                <div className="mt-1">
                  Adds{' '}
                  <span className="font-mono font-semibold text-amber-300">
                    {formatDollars(row.baseUsd)}
                  </span>{' '}
                  paid +{' '}
                  <span className="font-mono font-semibold text-emerald-300">
                    {formatDollars(row.bonusUsd)}
                  </span>{' '}
                  free bonus credits
                </div>
              </div>
            </div>
          </div>
        );
      })}

      {subscription.cadence === KiloPassCadence.Monthly ? (
        subscription.status === 'paused' ? (
          <div className="text-muted-foreground text-xs">
            Unused paid credits never expire. Free bonus credits are not renewed while your
            subscription is paused; monthly credits resume when the subscription resumes.
          </div>
        ) : (
          <div className="text-muted-foreground text-xs">
            Unused paid credits never expire and roll over every month into your total. Free bonus
            credits are earned after using the month&apos;s paid credits. Unused free bonus credits
            do not roll over{expiresAtLabel ? ` and will expire on ${expiresAtLabel}.` : '.'}
          </div>
        )
      ) : null}
    </div>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-muted-foreground text-sm">{label}</div>
      <div className="font-medium">{value}</div>
    </div>
  );
}
