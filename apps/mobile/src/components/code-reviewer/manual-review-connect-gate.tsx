import { type Href, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { CenteredState } from '@/components/centered-state';
import { EmptyState } from '@/components/empty-state';
import { Button } from '@/components/ui/button';
import { GitPullRequest } from '@/components/ui/icons';
import { Text } from '@/components/ui/text';
import { PLATFORM_CAPABILITIES } from '@/lib/code-reviewer-config';

/**
 * The no-provider gate for manual review. A role that cannot manage the
 * organization's billing sees the shared read-only message (matching the
 * platform overview) instead of a Connect GitHub action that would dead-end
 * on the read-only provider screen; everyone else sees the CTA.
 */
export function ManualReviewConnectGate({
  scope,
  readOnly,
}: Readonly<{ scope: string; readOnly: boolean }>) {
  const router = useRouter();
  const { t } = useTranslation();

  if (readOnly) {
    return (
      <CenteredState className="px-6">
        <Text className="text-center text-xs text-muted-foreground">
          {t('codeReviewer.notConnectedReadOnly', { platform: PLATFORM_CAPABILITIES.github.label })}
        </Text>
      </CenteredState>
    );
  }

  return (
    <EmptyState
      icon={GitPullRequest}
      title={t('codeReviewer.manualReview.connectProvider')}
      description={t('codeReviewer.manualReview.connectProviderDescription')}
      action={
        // `mt-3 w-full` matches the near-identical PR-review connect gate
        // (pr-review-connect-gate.tsx) and the Code Reviewer
        // ProviderConnectCard, so the same Connect GitHub action is styled
        // the same wherever it appears.
        <Button
          className="mt-3 w-full"
          onPress={() => {
            router.push(`/(app)/(tabs)/(3_profile)/code-reviewer/${scope}/github` as Href);
          }}
        >
          <Text>{t('common.connectGithub')}</Text>
        </Button>
      }
    />
  );
}
