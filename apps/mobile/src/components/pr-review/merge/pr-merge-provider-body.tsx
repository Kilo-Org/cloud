import { type TFunction } from 'i18next';
import { type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';
import {
  type ProviderPrMergeBlockedReason,
  type ProviderPrMergeState,
  type ProviderReviewCapability,
} from '@kilocode/app-shared/provider-review';

import { PrFormSheetFooter } from '@/components/pr-review/pr-form-sheet-chrome';
import { PrReviewCapabilityBanner } from '@/components/pr-review/pr-review-capability-banner';
import { Button } from '@/components/ui/button';
import { Text } from '@/components/ui/text';
import { formatNumber } from '@/lib/format';
import { i18n } from '@/i18n';

function providerBlockedReasonText(
  reason: ProviderPrMergeBlockedReason,
  term: string,
  t: TFunction
): string {
  // Literal keys keep these lookups visible to the catalog check.
  const KEY_BY_CODE = {
    conflicts: 'prReview.merge.blocked.conflictsDetail',
    required_approvals: 'prReview.merge.blocked.requiredReviewsDetail',
    failing_pipeline: 'prReview.merge.providerBlocked.failingPipeline',
    pending_pipeline: 'prReview.merge.providerBlocked.pendingPipeline',
    draft: 'prReview.merge.providerBlocked.draft',
    permission: 'prReview.merge.providerBlocked.permission',
    other: null,
  } satisfies Record<ProviderPrMergeBlockedReason['code'], string | null>;
  const key = KEY_BY_CODE[reason.code];
  if (key === null) {
    return reason.message;
  }
  return t(key, { term });
}

function MergeRestrictionsList({
  mergeState,
  term,
}: Readonly<{ mergeState: ProviderPrMergeState; term: string }>) {
  const { t } = useTranslation();
  const hasConflictReason = mergeState.blockedReasons.some(reason => reason.code === 'conflicts');
  const hasApprovalsReason = mergeState.blockedReasons.some(
    reason => reason.code === 'required_approvals'
  );
  const hasPipelineReason = mergeState.blockedReasons.some(
    reason => reason.code === 'failing_pipeline' || reason.code === 'pending_pipeline'
  );
  const rows: { id: string; text: string }[] = [];
  if (mergeState.conflicts && !hasConflictReason) {
    rows.push({ id: 'conflicts', text: t('prReview.merge.blocked.conflictsDetail') });
  }
  if (mergeState.approvalsRequired > 0 && !hasApprovalsReason) {
    rows.push({
      id: 'approvals',
      text: t('prReview.merge.restrictions.approvalsRequired', {
        count: mergeState.approvalsRequired,
        displayCount: formatNumber(mergeState.approvalsRequired, i18n.language),
      }),
    });
  }
  if (mergeState.pipelineMustSucceed && !hasPipelineReason) {
    rows.push({
      id: 'pipeline',
      text: t('prReview.merge.restrictions.pipelineMustSucceed'),
    });
  }
  for (const reason of mergeState.blockedReasons) {
    rows.push({
      id: `blocked:${reason.code}:${reason.message}`,
      text: providerBlockedReasonText(reason, term, t),
    });
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <View className="gap-2 rounded-lg border border-border bg-secondary p-4">
      <Text className="text-sm font-medium text-foreground">
        {t('prReview.merge.restrictions.title')}
      </Text>
      {rows.map(row => (
        <Text key={row.id} className="text-xs text-muted-foreground">
          {'• '}
          {row.text}
        </Text>
      ))}
    </View>
  );
}

function ProviderAutoMergeBody({
  mergeState,
  term,
}: Readonly<{ mergeState: ProviderPrMergeState | null | undefined; term: string }>) {
  const { t } = useTranslation();
  return (
    <View className="gap-4 px-6 pt-4">
      {mergeState ? <MergeRestrictionsList mergeState={mergeState} term={term} /> : null}
      <Text className="text-sm text-muted-foreground">
        {t('prReview.merge.enableAutoMergeDescriptionTerm', { term })}
      </Text>
    </View>
  );
}

export function PrMergeProviderBody({
  providerAutoMerge,
  autoMergeCapability,
  mergeState,
  term,
  isMutating,
  onConfirm,
  onCancel,
  children,
}: Readonly<{
  providerAutoMerge: boolean;
  autoMergeCapability?: ProviderReviewCapability;
  mergeState?: ProviderPrMergeState | null;
  term: string;
  isMutating: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  children: ReactNode;
}>) {
  const { t } = useTranslation();
  function cancelButton() {
    return (
      <Button
        variant="ghost"
        onPress={onCancel}
        disabled={isMutating}
        className="mt-2"
        accessibilityLabel={t('common.cancel')}
      >
        <Text>{t('common.cancel')}</Text>
      </Button>
    );
  }

  if (providerAutoMerge && autoMergeCapability?.supported === false) {
    return (
      <>
        <View className="gap-4 px-6 pt-4">
          <PrReviewCapabilityBanner capability={autoMergeCapability} />
        </View>
        <View className="flex-1" />
        <PrFormSheetFooter>{cancelButton()}</PrFormSheetFooter>
      </>
    );
  }
  if (providerAutoMerge) {
    return (
      <>
        <ProviderAutoMergeBody mergeState={mergeState} term={term} />
        <View className="flex-1" />
        <PrFormSheetFooter>
          <Button
            onPress={onConfirm}
            loading={isMutating}
            disabled={isMutating}
            accessibilityLabel={t('prReview.merge.enableAutoMerge')}
          >
            <Text>{t('prReview.merge.enableAutoMerge')}</Text>
          </Button>
          {cancelButton()}
        </PrFormSheetFooter>
      </>
    );
  }
  if (mergeState && !mergeState.canMerge) {
    return (
      <>
        <View className="gap-4 px-6 pt-4">
          <MergeRestrictionsList mergeState={mergeState} term={term} />
        </View>
        <View className="flex-1" />
        <PrFormSheetFooter>{cancelButton()}</PrFormSheetFooter>
      </>
    );
  }
  return (
    <>
      {mergeState ? (
        <View className="px-6 pt-4">
          <MergeRestrictionsList mergeState={mergeState} term={term} />
        </View>
      ) : null}
      {children}
    </>
  );
}
