// The provider merge section (s6). The GitHub section derives its gate from
// the GitHub overview DTO; a GitLab MR / Bitbucket PR normalizes `mergeable`
// to null, so this arm offers the merge affordance directly and lets the
// confirmation sheet — which reads `providerReview.getMergeState` — render
// the restrictions list and refuse the submit. Both merge affordances follow
// the capability list: GitLab (supported) gets the buttons, Bitbucket gets the
// explicit capability banner with the provider's reason — never a dead button
// and never a silent absence. Bitbucket's reason is that its merge endpoint
// takes no revision precondition, so the app cannot pin a merge to the head
// the reviewer saw (the server refuses that input with the same copy).

import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { PrReviewCapabilityBanner } from '@/components/pr-review/pr-review-capability-banner';
import { TerminalChip } from '@/components/pr-review/merge/pr-merge-section-parts';
import { providerPrNounKey } from '@/components/pr-review/pr-review-provider-noun';
import { providerPrSheetHref } from '@/components/pr-review/pr-review-provider-sheet-href';
import { Button } from '@/components/ui/button';
import { GitMerge } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { providerPrCapabilities, type ProviderPrRef } from '@/lib/pr-review/provider-pr-ref';

type PrMergeSectionProviderProps = Readonly<{
  /** The provider ref the section pushes its sheet route under. */
  prRef: ProviderPrRef;
  /** The overview lifecycle state; `open` is the only mergeable one. */
  state: 'open' | 'closed' | 'merged';
}>;

export function PrMergeSectionProvider({ prRef, state }: PrMergeSectionProviderProps) {
  const router = useRouter();
  const colors = useThemeColors();
  const { t } = useTranslation();

  if (state !== 'open') {
    // Provider wording (s6): a closed GitLab merge request says "merge
    // request"; Bitbucket keeps "pull request" — that is its own noun.
    return <TerminalChip state={state} nounKey={providerPrNounKey(prRef.platform)} />;
  }

  const capabilities = providerPrCapabilities(prRef.platform);
  const canMerge = capabilities.canMerge;
  const autoMerge = capabilities.autoMerge;
  const mergeLabel = t('prReview.merge.mergeTermTitle', {
    term: t(providerPrNounKey(prRef.platform)),
  });

  return (
    <View className="gap-2">
      <Text variant="small" className="uppercase tracking-wide text-muted-foreground">
        {t('prReview.merge.merge')}
      </Text>
      {canMerge.supported ? (
        <Button
          onPress={() => {
            router.push(providerPrSheetHref(prRef, 'merge', { mode: 'merge' }));
          }}
          accessibilityLabel={mergeLabel}
        >
          <View className="flex-row items-center gap-2">
            <GitMerge size={14} color={colors.primaryForeground} />
            <Text>{t('prReview.merge.merge')}</Text>
          </View>
        </Button>
      ) : (
        <PrReviewCapabilityBanner capability={canMerge} />
      )}
      {autoMerge.supported ? (
        <Button
          variant="outline"
          onPress={() => {
            router.push(
              providerPrSheetHref(prRef, 'merge', {
                mode: 'enable-auto-merge',
              })
            );
          }}
          accessibilityLabel={t('prReview.merge.enableAutoMerge')}
        >
          <Text>{t('prReview.merge.enableAutoMerge')}</Text>
        </Button>
      ) : (
        <PrReviewCapabilityBanner capability={autoMerge} />
      )}
    </View>
  );
}
