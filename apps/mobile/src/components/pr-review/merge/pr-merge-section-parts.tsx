// Sub-components for the S8 merge section. Extracted out of
// `pr-merge-section.tsx` so the section file stays under the
// repo's 300-line limit.

import { type LucideIcon, RefreshCw } from '@/components/ui/icons';
import { ActivityIndicator, View } from 'react-native';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { mergeBlockedReasonIcon } from '@/components/pr-review/merge/pr-merge-icons';
import {
  type MergeBlockedReason,
  type PrOverviewDto,
} from '@/lib/pr-review/merge/merge-blocked-reasons';

export function TerminalChip({ state }: Readonly<{ state: PrOverviewDto['state'] }>) {
  const { t } = useTranslation();
  const label =
    state === 'merged'
      ? t('prReview.merge.terminal.alreadyMerged')
      : t('prReview.merge.terminal.closed');
  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('prReview.merge.merge')}
      </Text>
      <View className="rounded-lg bg-secondary p-4">
        <Text className="text-sm text-muted-foreground">{label}</Text>
      </View>
    </View>
  );
}

export function MergeabilityCheckingRow() {
  const { t } = useTranslation();
  return (
    <View className="flex-row items-center gap-2 rounded-lg bg-secondary p-4">
      <ActivityIndicator size="small" />
      <Text className="text-sm text-muted-foreground">{t('prReview.merge.checking')}</Text>
    </View>
  );
}

export function MergeabilityTimedOutRow({
  onRefresh,
  isRefreshing,
}: Readonly<{ onRefresh: () => void; isRefreshing: boolean }>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  return (
    <View className="gap-2 rounded-lg bg-secondary p-4">
      <Text className="text-sm text-muted-foreground">{t('prReview.merge.couldNotDetermine')}</Text>
      <Button
        variant="outline"
        size="sm"
        onPress={() => {
          onRefresh();
        }}
        loading={isRefreshing}
        accessibilityLabel={t('prReview.merge.refreshMergeability')}
      >
        <View className="flex-row items-center gap-2">
          <RefreshCw size={14} color={colors.foreground} />
          <Text>{t('common.refresh')}</Text>
        </View>
      </Button>
    </View>
  );
}

function BlockedReasonRow({ reason }: Readonly<{ reason: MergeBlockedReason }>) {
  const colors = useThemeColors();
  const Icon: LucideIcon = mergeBlockedReasonIcon(reason.iconKind);
  const tone = (() => {
    if (reason.severity === 'destructive') {
      return colors.destructive;
    }
    if (reason.severity === 'warn') {
      return colors.warn;
    }
    return colors.mutedForeground;
  })();
  return (
    <View className="flex-row items-start gap-3 border-t-[0.5px] border-hair-soft px-4 py-3">
      <Icon size={16} color={tone} />
      <View className="flex-1 gap-0.5">
        <Text className="text-sm font-medium text-foreground">{reason.title}</Text>
        <Text variant="muted" className="text-xs">
          {reason.detail}
        </Text>
      </View>
    </View>
  );
}

export function BlockedPanel({
  reasons,
  allowUpdateBranch,
  isUpdatePending,
  onUpdateBranch,
}: Readonly<{
  reasons: MergeBlockedReason[];
  allowUpdateBranch: boolean;
  isUpdatePending: boolean;
  onUpdateBranch: () => void;
}>) {
  const hasBehindReason = reasons.some(r => r.id === 'behind');
  const { t } = useTranslation();
  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('prReview.merge.blockedTitle')}
      </Text>
      <View className="overflow-hidden rounded-lg bg-secondary">
        {reasons.map(reason => (
          <BlockedReasonRow key={reason.id} reason={reason} />
        ))}
      </View>
      {hasBehindReason && allowUpdateBranch ? (
        <Button
          variant="outline"
          onPress={onUpdateBranch}
          loading={isUpdatePending}
          accessibilityLabel={t('prReview.merge.updateBranchFromBase')}
        >
          <Text>{t('prReview.merge.updateBranch')}</Text>
        </Button>
      ) : null}
    </View>
  );
}

export function AutoMergeEnabledBanner({
  method,
  onDisable,
  isDisabling,
}: Readonly<{ method: string; onDisable: () => void; isDisabling: boolean }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-3 rounded-lg bg-accent-soft p-4">
      <View className="gap-1">
        <Text className="text-sm font-medium text-accent-soft-foreground">
          {t('prReview.merge.autoMergeOn')}
        </Text>
        <Text className="text-xs text-accent-soft-foreground">
          {t('prReview.merge.autoMergeDescription', { method: method.toLowerCase() })}
        </Text>
      </View>
      <Button
        variant="outline"
        onPress={onDisable}
        loading={isDisabling}
        accessibilityLabel={t('prReview.merge.disableAutoMerge')}
      >
        <Text>{t('prReview.merge.disableAutoMerge')}</Text>
      </Button>
    </View>
  );
}
