import { type Href, useLocalSearchParams } from 'expo-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Alert, Pressable, View } from 'react-native';
import { toast } from 'sonner-native';
import { z } from 'zod';

import { performCopy } from '@/components/agents/use-message-copy';
import { InvalidRouteState } from '@/components/invalid-route-state';
import { QueryError } from '@/components/query-error';
import { ScreenHeader } from '@/components/screen-header';
import { TabScreenScrollView } from '@/components/tab-screen';
import { Button } from '@/components/ui/button';
import { Copy } from '@/components/ui/icons';
import { KvRow } from '@/components/ui/kv-row';
import { RowGroup } from '@/components/ui/row-group';
import { RowSkeleton } from '@/components/ui/row-skeleton';
import { Section } from '@/components/ui/section';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  STATE_ACTION_CLASS,
} from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useTRPC } from '@/lib/trpc';
import { cn } from '@/lib/utils';
import { i18n } from '@/i18n';

const ACCOUNT_ROUTE = '/(app)/(tabs)/(3_profile)/account' as Href;

const ReceiptParamSchema = z.object({ 'receipt-id': z.uuid() });

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

const NEXT_STEP_KEYS = {
  received: 'profile.reportReceipt.nextStepReceived',
  inReview: 'profile.reportReceipt.nextStepInReview',
  appeal: 'profile.reportReceipt.nextStepAppeal',
  final: 'profile.reportReceipt.nextStepFinal',
} as const;

/**
 * The sentence that says what happens next, or `null` when there is nothing to
 * add: the appeal button is the next step itself, and a status the server adds
 * is shown by its row without a sentence this screen cannot derive.
 */
function nextStepKey(triageStatus: string, appealStatus: string): string | null {
  if (appealStatus === 'submitted') {
    return NEXT_STEP_KEYS.appeal;
  }
  if (appealStatus === 'accepted' || appealStatus === 'rejected') {
    return NEXT_STEP_KEYS.final;
  }
  if (appealStatus !== 'none') {
    return null;
  }
  if (triageStatus === 'received') {
    return NEXT_STEP_KEYS.received;
  }
  if (triageStatus === 'open') {
    return NEXT_STEP_KEYS.inReview;
  }
  return null;
}

/**
 * Translates a status the server reports, through the key its dictionary holds.
 * An unrecognised status is shown as the server sent it, so a status added on the
 * server is readable rather than blank.
 */
function statusLabel(dictionary: Readonly<Record<string, string>>, status: string): string {
  const key = dictionary[status];
  return key === undefined ? status : i18n.t(key);
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
 *
 * The screen states the next step whenever it offers no appeal, and stays silent
 * when the appeal button is the next step.
 */
export function ReportReceiptScreen() {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const params = useLocalSearchParams();
  const parsed = ReceiptParamSchema.safeParse(params);
  const receiptId = parsed.success ? parsed.data['receipt-id'] : null;

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
        <View className="gap-3 px-4 pt-3">
          <RowGroup>
            <RowSkeleton />
            <RowSkeleton />
          </RowGroup>
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

  const nextStep = nextStepKey(receipt.data.triageStatus, receipt.data.appealStatus);

  return (
    <View className="flex-1 bg-background">
      <ScreenHeader title={t('profile.reportReceipt.title')} />
      <TabScreenScrollView
        className="flex-1"
        contentContainerClassName={SCREEN_BODY_CLASS}
        showsVerticalScrollIndicator={false}
      >
        <Section>
          <Text variant="caption">{t('profile.reportReceipt.description')}</Text>
          <RowGroup>
            <KvRow
              label={t('profile.reportReceipt.receiptLabel')}
              value={receipt.data.receiptId}
              trailing={
                <Pressable
                  className={cn(COMPACT_CONTROL_BOX_CLASS, 'active:opacity-70')}
                  hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
                  accessibilityRole="button"
                  accessibilityLabel={t('profile.reportReceipt.copyReceiptId')}
                  onPress={() => {
                    void performCopy(receipt.data.receiptId);
                  }}
                >
                  <Copy size={16} color={colors.mutedForeground} />
                </Pressable>
              }
            />
            <KvRow
              label={t('common.status')}
              value={statusLabel(TRIAGE_KEYS, receipt.data.triageStatus)}
              valueFace="text"
              // A status is a phrase, not an identifier: cutting its middle
              // would drop the words that say what happened.
              valueEllipsizeMode="tail"
            />
            <KvRow
              label={t('profile.reportReceipt.appealLabel')}
              value={statusLabel(APPEAL_KEYS, receipt.data.appealStatus)}
              valueFace="text"
              valueEllipsizeMode="tail"
            />
          </RowGroup>
          {nextStep === null ? null : <Text variant="caption">{t(nextStep)}</Text>}
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
                      onPress: () => {
                        appeal.mutate({ receiptId });
                      },
                    },
                  ],
                  // Android back dismisses, which equals Cancel: no appeal is sent.
                  { cancelable: true }
                );
              }}
            >
              <Text>{t('profile.reportReceipt.appeal')}</Text>
            </Button>
          ) : null}
        </Section>
      </TabScreenScrollView>
    </View>
  );
}
