import { useMutation, useQueryClient } from '@tanstack/react-query';
import { type inferRouterOutputs, type MobileRouter } from '@kilocode/trpc/mobile';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { toast } from 'sonner-native';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/dialog';
import { Text } from '@/components/ui/text';
import { i18n } from '@/i18n';
import { formatDate } from '@/lib/format';
import {
  isStoreManagedPass,
  type KiloPassSubscriptionState,
  selectKiloPassManagementAction,
} from '@/lib/kilo-pass/management';
import { kiloPassPlanLabel } from '@/lib/kilo-pass/state';
import { reconcileFirstPage } from '@/lib/query/infinite-retention';
import { useTRPC } from '@/lib/trpc';
import { parseTimestamp } from '@/lib/utils';

export type KiloPassScheduledChange = NonNullable<
  inferRouterOutputs<MobileRouter>['kiloPass']['getScheduledChange']['scheduledChange']
>;

/**
 * What a subscriber can do to their pass from the phone: cancel it, undo a
 * pending cancellation, resume a paused pass, and cancel a scheduled plan
 * change — all through this app's own procedures.
 *
 * A pass the App Store or Play sold has no controls here: Kilo Pass is no
 * longer sold in either store, so the surface states the pass it has and offers
 * no manage or change-plan destination at all.
 *
 * The scheduled change arrives as a prop, because the screen waits for its
 * answer before it prints the page: a card that appeared later would push the
 * rows under it.
 */
export function KiloPassManagementSections({
  subscription,
  scheduledChange,
}: Readonly<{
  subscription: KiloPassSubscriptionState;
  scheduledChange: KiloPassScheduledChange | null;
}>) {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const { confirm, dialog } = useConfirmDialog();
  const storeManaged = isStoreManagedPass(subscription);

  const invalidateKiloPass = () => {
    void queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getState.pathKey() });
    void queryClient.invalidateQueries({ queryKey: trpc.kiloPass.getScheduledChange.pathKey() });
    // Both ledgers are infinite lists that keep several pages. Invalidating one
    // refetches every retained page — one Stripe `invoices.list` per billing
    // page — so the refresh reads page one and leaves the rows on screen until
    // it lands.
    void reconcileFirstPage(queryClient, trpc.kiloPass.getBillingHistory.pathFilter().queryKey);
    void reconcileFirstPage(queryClient, trpc.kiloPass.getCreditHistory.pathFilter().queryKey);
  };

  const cancelSubscription = useMutation(
    trpc.kiloPass.cancelSubscription.mutationOptions({
      onSuccess: () => {
        toast.success(t('kiloPass.manage.cancelled'));
        invalidateKiloPass();
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );
  const resumeCancelled = useMutation(
    trpc.kiloPass.resumeCancelledSubscription.mutationOptions({
      onSuccess: () => {
        toast.success(t('kiloPass.manage.resumed'));
        invalidateKiloPass();
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );
  const resumePaused = useMutation(
    trpc.kiloPass.resumePausedSubscription.mutationOptions({
      onSuccess: () => {
        toast.success(t('kiloPass.manage.resumed'));
        invalidateKiloPass();
      },
      onError: error => {
        toast.error(error.message);
      },
    })
  );
  const cancelScheduledChange = useMutation(
    trpc.kiloPass.cancelScheduledChange.mutationOptions({
      onSuccess: invalidateKiloPass,
      onError: error => {
        toast.error(error.message);
      },
    })
  );

  // A pass the store sold keeps its details above and offers nothing to manage
  // here: Kilo Pass is no longer sold in either store, so there is no store page
  // to send the reader to and no paid plan change to offer.
  if (storeManaged) {
    return null;
  }

  const action = selectKiloPassManagementAction(subscription);
  const isResuming = resumeCancelled.isPending || resumePaused.isPending;

  const confirmResume = () => {
    Alert.alert(
      t('kiloPass.manage.resume'),
      action === 'resume-paused'
        ? t('kiloPass.manage.resumePausedDescription')
        : t('kiloPass.manage.resumeCancelledDescription'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('kiloPass.manage.resume'),
          onPress: () => {
            if (action === 'resume-paused') {
              resumePaused.mutate();
              return;
            }
            resumeCancelled.mutate();
          },
        },
      ],
      // Android back dismisses, which equals Cancel: nothing resumes.
      { cancelable: true }
    );
  };

  const confirmCancelScheduledChange = () => {
    Alert.alert(
      t('kiloPass.manage.cancelScheduledChange'),
      t('kiloPass.manage.scheduledChangeCancelDescription'),
      [
        { text: t('common.cancel'), style: 'cancel' },
        {
          text: t('kiloPass.manage.cancelScheduledChange'),
          onPress: () => {
            cancelScheduledChange.mutate();
          },
        },
      ],
      // Android back dismisses, which equals Cancel: no change is cancelled.
      { cancelable: true }
    );
  };

  return (
    <View className="gap-3">
      {action === 'cancel' && (
        <Button
          variant="outline"
          loading={cancelSubscription.isPending}
          onPress={() => {
            confirm({
              title: t('kiloPass.manage.cancel'),
              message: t('kiloPass.manage.cancelDescription'),
              confirmLabel: t('kiloPass.manage.cancel'),
              onConfirm: () => {
                cancelSubscription.mutate();
              },
            });
          }}
        >
          <Text className="text-destructive">{t('kiloPass.manage.cancel')}</Text>
        </Button>
      )}
      {(action === 'resume-cancelled' || action === 'resume-paused') && (
        <Button variant="outline" loading={isResuming} onPress={confirmResume}>
          <Text>{t('kiloPass.manage.resume')}</Text>
        </Button>
      )}

      {scheduledChange != null && (
        <View className="gap-2 rounded-lg bg-secondary p-3">
          <Text className="text-sm font-medium text-foreground">
            {t('kiloPass.manage.scheduledChange')}
          </Text>
          <Text className="text-xs text-muted-foreground">
            {t('kiloPass.manage.scheduledChangeSummary', {
              plan: kiloPassPlanLabel(scheduledChange.toTier, scheduledChange.toCadence),
              date: formatDate(parseTimestamp(scheduledChange.effectiveAt), i18n.language, {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              }),
            })}
          </Text>
          <Button
            variant="outline"
            size="sm"
            loading={cancelScheduledChange.isPending}
            onPress={confirmCancelScheduledChange}
          >
            <Text>{t('kiloPass.manage.cancelScheduledChange')}</Text>
          </Button>
        </View>
      )}

      {dialog}
    </View>
  );
}
