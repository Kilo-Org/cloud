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
import { Card } from '@/components/ui/card';
import { Text } from '@/components/ui/text';
import { formatNumber } from '@/lib/format';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { useSideInsetStyle } from '@/lib/screen-insets';
import { i18n } from '@/i18n';

// Literal keys keep these lookups visible to the catalog check. Every code has
// catalog copy: a provider's own message is not shown in the row, because it is
// unlocalized provider prose; `other` carries it as the row's detail instead.
const BLOCKED_REASON_KEYS = {
  conflicts: 'prReview.merge.blocked.conflictsDetail',
  required_approvals: 'prReview.merge.blocked.requiredReviewsDetail',
  failing_pipeline: 'prReview.merge.providerBlocked.failingPipeline',
  pending_pipeline: 'prReview.merge.providerBlocked.pendingPipeline',
  draft: 'prReview.merge.providerBlocked.draft',
  not_open: 'prReview.merge.blocked.notOpenDetail',
  unresolved_discussions: 'prReview.merge.blocked.unresolvedDiscussionsDetail',
  unresolved_tasks: 'prReview.merge.blocked.unresolvedTasksDetail',
  permission: 'prReview.merge.providerBlocked.permission',
  other: 'prReview.merge.blocked.otherDetail',
} satisfies Record<ProviderPrMergeBlockedReason['code'], string>;

function providerBlockedReasonText(
  reason: ProviderPrMergeBlockedReason,
  term: string,
  t: TFunction
): string {
  return t(BLOCKED_REASON_KEYS[reason.code], { term });
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
  const rows: { id: string; text: string; detail?: string }[] = [];
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
      // Only `other` has no self-explanatory cause, so only it repeats the
      // provider's own sentence; every other code's message is either the same
      // thing in English provider prose or noise under the catalog line.
      ...(reason.code === 'other' ? { detail: reason.message } : {}),
    });
  }
  if (rows.length === 0) {
    return null;
  }
  return (
    <Card className="gap-2">
      <Text className="text-sm font-medium text-foreground">
        {t('prReview.merge.restrictions.title')}
      </Text>
      {rows.map(row => (
        <View key={row.id} className="gap-0.5">
          <Text className="text-xs text-muted-foreground">
            {'• '}
            {row.text}
          </Text>
          {row.detail === undefined ? null : (
            // The provider's own sentence, under the app's words for the same
            // cause. `ps-2` is about the width of the bullet and its space at
            // this size, so the second line starts under the row's text rather
            // than under the marker; `direction="auto"` names the content's own
            // direction, since the provider wrote it, not the catalog.
            <Text variant="muted" className="ps-2 text-xs" direction="auto">
              {row.detail}
            </Text>
          )}
        </View>
      ))}
    </Card>
  );
}

function ProviderAutoMergeBody({
  mergeState,
  term,
}: Readonly<{ mergeState: ProviderPrMergeState | null | undefined; term: string }>) {
  const { t } = useTranslation();
  const sideInsetStyle = useSideInsetStyle();
  return (
    <View style={sideInsetStyle}>
      <View className={SCREEN_BODY_CLASS}>
        {mergeState ? <MergeRestrictionsList mergeState={mergeState} term={term} /> : null}
        <Text className="text-sm text-muted-foreground">
          {t('prReview.merge.enableAutoMergeDescriptionTerm', { term })}
        </Text>
      </View>
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
  const sideInsetStyle = useSideInsetStyle();
  function cancelButton() {
    return (
      <Button
        variant="ghost"
        onPress={onCancel}
        disabled={isMutating}
        className="mt-2"
        accessibilityLabel={t('common.discard')}
      >
        <Text>{t('common.discard')}</Text>
      </Button>
    );
  }

  if (providerAutoMerge && autoMergeCapability?.supported === false) {
    return (
      <>
        <View style={sideInsetStyle}>
          <View className="px-4 pt-3">
            <PrReviewCapabilityBanner capability={autoMergeCapability} />
          </View>
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
        <View style={sideInsetStyle}>
          <View className={SCREEN_BODY_CLASS}>
            <MergeRestrictionsList mergeState={mergeState} term={term} />
          </View>
        </View>
        <View className="flex-1" />
        <PrFormSheetFooter>{cancelButton()}</PrFormSheetFooter>
      </>
    );
  }
  return (
    <>
      {mergeState ? (
        <View style={sideInsetStyle}>
          <View className="px-4 pt-3">
            <MergeRestrictionsList mergeState={mergeState} term={term} />
          </View>
        </View>
      ) : null}
      {children}
    </>
  );
}
