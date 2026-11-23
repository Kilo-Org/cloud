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

/**
 * The merge gate the sheet body renders from: `github` is the arm with no
 * provider merge read at all, `unknown` is a provider arm whose merge-state
 * read produced no value yet, and the two provider modes carry the verdict
 * and — for auto-merge — the provider's capability answer.
 */
export type PrMergeGate =
  | Readonly<{ kind: 'github' }>
  | Readonly<{ kind: 'unknown' }>
  | Readonly<{ kind: 'merge'; mergeState: ProviderPrMergeState }>
  | Readonly<{
      kind: 'auto-merge';
      mergeState: ProviderPrMergeState;
      capability?: ProviderReviewCapability;
    }>;

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
    <Card className="gap-2">
      <Text className="text-sm font-medium text-foreground">
        {t('prReview.merge.restrictions.title')}
      </Text>
      {rows.map(row => (
        <Text key={row.id} className="text-xs text-muted-foreground">
          {'• '}
          {row.text}
        </Text>
      ))}
    </Card>
  );
}

function ProviderAutoMergeBody({
  mergeState,
  term,
}: Readonly<{ mergeState: ProviderPrMergeState; term: string }>) {
  const { t } = useTranslation();
  const sideInsetStyle = useSideInsetStyle();
  return (
    <View style={sideInsetStyle}>
      <View className={SCREEN_BODY_CLASS}>
        <MergeRestrictionsList mergeState={mergeState} term={term} />
        <Text className="text-sm text-muted-foreground">
          {t('prReview.merge.enableAutoMergeDescriptionTerm', { term })}
        </Text>
      </View>
    </View>
  );
}

/**
 * The provider arm's sheet body. The screen (`pr-review-merge-screen.tsx`)
 * mounts the sheet only after the provider merge-state read returns, so an
 * `unknown` gate is the contract-violation terminal: it renders the reason and
 * a Discard, never a confirm control. Only an established allowed verdict or
 * the GitHub arm reaches the child form. The restrictions list stays advisory:
 * the merge write (`providerReview.mergePullRequest`) re-fetches the review,
 * fences the expected head SHA and lets the provider refuse a merge its policy
 * blocks, so the list is never the authorization.
 */
export function PrMergeProviderBody({
  gate,
  term,
  isMutating,
  onConfirm,
  onCancel,
  children,
}: Readonly<{
  gate: PrMergeGate;
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
  if (gate.kind === 'unknown') {
    return (
      <>
        <View style={sideInsetStyle}>
          <View className={SCREEN_BODY_CLASS}>
            <Card>
              <Text className="text-sm text-muted-foreground">
                {t('prReview.merge.couldNotDetermine')}
              </Text>
            </Card>
          </View>
        </View>
        <View className="flex-1" />
        <PrFormSheetFooter>{cancelButton()}</PrFormSheetFooter>
      </>
    );
  }
  if (gate.kind === 'auto-merge' && gate.capability?.supported === false) {
    return (
      <>
        <View style={sideInsetStyle}>
          <View className="px-4 pt-3">
            <PrReviewCapabilityBanner capability={gate.capability} />
          </View>
        </View>
        <View className="flex-1" />
        <PrFormSheetFooter>{cancelButton()}</PrFormSheetFooter>
      </>
    );
  }
  if (gate.kind === 'auto-merge') {
    return (
      <>
        <ProviderAutoMergeBody mergeState={gate.mergeState} term={term} />
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
  if (gate.kind === 'merge' && !gate.mergeState.canMerge) {
    return (
      <>
        <View style={sideInsetStyle}>
          <View className={SCREEN_BODY_CLASS}>
            <MergeRestrictionsList mergeState={gate.mergeState} term={term} />
          </View>
        </View>
        <View className="flex-1" />
        <PrFormSheetFooter>{cancelButton()}</PrFormSheetFooter>
      </>
    );
  }
  return (
    <>
      {gate.kind === 'merge' ? (
        <View style={sideInsetStyle}>
          <View className="px-4 pt-3">
            <MergeRestrictionsList mergeState={gate.mergeState} term={term} />
          </View>
        </View>
      ) : null}
      {children}
    </>
  );
}
