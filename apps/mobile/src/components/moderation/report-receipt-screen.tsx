import { type Href, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';
import { toast } from 'sonner-native';
import { z } from 'zod';

import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import { STATE_ACTION_CLASS } from '@/lib/a11y/tap-target';
import { useTRPC } from '@/lib/trpc';

const ACCOUNT_ROUTE = '/(app)/(tabs)/(3_profile)/account' as Href;

const ReceiptParamSchema = z.object({ receiptId: z.uuid() });

const TRIAGE_KEYS = {
  received: 'profile.reportReceipt.triageReceived',
  open: 'profile.reportReceipt.triageOpen',
  actioned: 'profile.reportReceipt.triageActioned',
  rejected: 'profile.reportReceipt.triageRejected',
} as const;

const APPEAL_KEYS = {
  none: 'profile.reportReceipt.appealNone',
  submitted: 'profile.reportReceipt.appealSubmitted',
  accepted: 'profile.reportReceipt.appealAccepted',
  rejected: 'profile.reportReceipt.appealRejected',
} as const;

/** Looks a status up by its literal key without widening the dictionary's type. */
function statusLabel(dictionary: Readonly<Record<string, string>>, status: string): string {
  return dictionary[status] ?? status;
}

function StatusRow({ label, value }: Readonly<{ label: string; value: string }>) {
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-lg bg-secondary p-3">
      <Text className="text-sm text-muted-foreground" numberOfLines={1}>
        {label}
      </Text>
      <Text className="text-sm font-medium text-foreground" numberOfLines={1}>
        {value}
      </Text>
    </View>
  );
}

/**
 * The state of one moderation report, and the way to appeal it.
 *
 * The receipt id arrives as a route parameter, so it is validated as a UUID
 * before it is sent, and a receipt that is not this reader's is a not-found the
 * server reports identically for both cases: the screen shows the invalid-link
 * state rather than the retry it would offer for a failure that could pass.
 *
 * An appeal can be submitted once. When it can, the button asks first: the
 * submission cannot be taken back, so it is confirmed the way a non-destructive
 * but final action is (`Alert.alert`), not with the red affordance of a deletion.
 */
export function ReportReceiptScreen() {
  const { t } = useTranslation();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams();
  const parsed = ReceiptParamSchema.safeParse(params);
  const receiptId = parsed.success ? parsed.data.receiptId : null;

  const receipt = useQuery({
    ...trpc.moderation.getReportReceipt.queryOptions({ receiptId: receiptId ?? '' }),
    enabled: receiptId !== null,
  });

  const appeal = useMutation(
    trpc.moderation.appealReport.mutationOptions({
      onSuccess: () => {
        void queryClient.invalidateQueries({
          queryKey: trpc.moderation.getReportReceipt.queryKey({ receiptId: receiptId ?? '' }),
        });
        announcingToast.success(t('profile.reportReceipt.appealed'));
      },
      onError: error => toast.error(error.message),
    })
  );

  if (receiptId === null) {
    return <InvalidRouteState backTo={ACCOUNT_ROUTE} />;
  }

  if (receipt.isPending) {
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('profile.reportReceipt.title')} />
        <View className="gap-3 px-4 pt-4">
          <Skeleton className="h-[46px] rounded-lg" />
          <Skeleton className="h-[46px] rounded-lg" />
        </View>
      </View>
    );
  }

  if (receipt.isError) {
    // A receipt the server does not hold for this reader is not retryable; a
    // failure that could pass keeps its retry.
    if (receipt.error.data?.code === 'NOT_FOUND') {
      return <InvalidRouteState backTo={ACCOUNT_ROUTE} />;
    }
    return (
      <View className="flex-1 bg-background">
        <ScreenHeader title={t('profile.reportReceipt.title')} />
        <QueryError onRetry={() => void receipt.refetch()} isRetrying={receipt.isFetching} />
      </View>
    );
  }

  const appealable =
    receipt.data.appealStatus === 'none' &&
    (receipt.data.triageStatus === 'actioned' || receipt.data.triageStatus === 'rejected');

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.reportReceipt.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName="gap-6 px-4 pt-4"
        showsVerticalScrollIndicator={false}
      >
        <Text variant="muted" className="text-xs">
          {t('profile.reportReceipt.description')}
        </Text>
        <View className="gap-3">
          <StatusRow
            label={t('profile.reportReceipt.receiptLabel')}
            value={receipt.data.receiptId}
          />
          <StatusRow
            label={t('common.status')}
            value={statusLabel(TRIAGE_KEYS, receipt.data.triageStatus)}
          />
          <StatusRow
            label={t('profile.reportReceipt.appealLabel')}
            value={statusLabel(APPEAL_KEYS, receipt.data.appealStatus)}
          />
        </View>
        {appealable ? (
          <Button
            variant="outline"
            className={STATE_ACTION_CLASS}
            loading={appeal.isPending}
            disabled={appeal.isPending}
            onPress={() => {
              Alert.alert(
                t('profile.reportReceipt.appealTitle'),
                t('profile.reportReceipt.appealMessage'),
                [
                  { text: t('common.cancel'), style: 'cancel' },
                  {
                    text: t('profile.reportReceipt.appealConfirm'),
                    onPress: () => appeal.mutate({ receiptId }),
                  },
                ]
              );
            }}
          >
            <Text>{t('profile.reportReceipt.appeal')}</Text>
          </Button>
        ) : null}
      </TabScreenScrollView>
    </View>
  );
}
