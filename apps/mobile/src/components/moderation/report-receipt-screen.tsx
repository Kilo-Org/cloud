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
import { Skeleton } from '@/components/ui/skeleton';
import { Text } from '@/components/ui/text';
import { announcingToast } from '@/lib/a11y/announcing-toast';
import {
  COMPACT_CONTROL_BOX_CLASS,
  COMPACT_CONTROL_HIT_SLOP_DP,
  STATE_ACTION_CLASS,
} from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
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
 * One label/value line. `copyLabel` turns the row into one whose value the
 * reader can carry away: the control copies the whole value it was given, so an
 * id the row truncates still reaches the clipboard in one piece.
 *
 * The control takes width from the value, which on a 360 dp screen leaves too
 * little for the whole id. So a copy row gives its value a second line, and the
 * value wraps into it instead of losing characters: the id the description asks
 * the reader to keep stays readable, not only copyable. Two lines bound the row's
 * growth, so a value longer than both keeps the end cut that the platform serves
 * for multi-line text, and the copy control carries the whole value regardless.
 * A row without a control holds none and keeps one line, as the status rows do.
 */
function StatusRow({
  label,
  value,
  copyLabel,
}: Readonly<{ label: string; value: string; copyLabel?: string }>) {
  const colors = useThemeColors();
  return (
    <View className="flex-row items-center justify-between gap-3 rounded-lg bg-secondary p-3">
      <Text className="shrink text-sm text-muted-foreground" numberOfLines={1}>
        {label}
      </Text>
      <View className="min-w-0 flex-1 flex-row items-center justify-end gap-2">
        <Text
          className="min-w-0 shrink text-sm font-medium text-foreground"
          numberOfLines={copyLabel === undefined ? 1 : 2}
        >
          {value}
        </Text>
        {copyLabel === undefined ? null : (
          <Pressable
            // The compact box carries the whole tap target, and its negative
            // margin cancels back to one text line, so the row is as high as
            // its wrapped value and no higher.
            className={cn(COMPACT_CONTROL_BOX_CLASS, '-my-[7px]', 'active:opacity-70')}
            hitSlop={COMPACT_CONTROL_HIT_SLOP_DP}
            accessibilityRole="button"
            accessibilityLabel={copyLabel}
            onPress={() => {
              void performCopy(value);
            }}
          >
            <Copy size={16} color={colors.mutedForeground} />
          </Pressable>
        )}
      </View>
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
            copyLabel={t('profile.reportReceipt.copyReceiptId')}
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
                    onPress: () => {
                      appeal.mutate({ receiptId });
                    },
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
