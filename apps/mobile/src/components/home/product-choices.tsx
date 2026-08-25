import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SectionHeader } from '@/components/home/section-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { GitMerge, GitPullRequest, ShieldCheck } from '@/components/ui/icons';
import { FEATURE_FLAG_PR_REVIEW, useFeatureFlag } from '@/lib/analytics/posthog';
import { getCodeReviewerProfilePath, getPrReviewEntryPath } from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';

type ProductChoicesProps = {
  organizationId: string | null;
};

export function ProductChoices({ organizationId }: Readonly<ProductChoicesProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  const scope = organizationId ?? PERSONAL_SECURITY_SCOPE;

  return (
    <View>
      <SectionHeader label={t('home.explore')} />
      <View className="mx-4 gap-2">
        <ConfigureRow
          icon={GitPullRequest}
          title={t('profile.codeReviewer')}
          subtitle={t('profile.codeReviewerSubtitle')}
          className="rounded-lg bg-secondary px-3"
          onPress={() => {
            router.push(getCodeReviewerProfilePath(scope));
          }}
        />
        <ConfigureRow
          icon={ShieldCheck}
          title={t('profile.securityAgent')}
          subtitle={t('profile.securityAgentSubtitle')}
          className="rounded-lg bg-secondary px-3"
          last={!prReviewEnabled}
          onPress={() => {
            router.push(getSecurityAgentPath(scope));
          }}
        />
        {prReviewEnabled ? (
          <ConfigureRow
            icon={GitMerge}
            title={t('profile.prReview')}
            subtitle={t('profile.prReviewSubtitle')}
            className="rounded-lg bg-secondary px-3"
            last
            onPress={() => {
              router.push(getPrReviewEntryPath());
            }}
          />
        ) : null}
      </View>
    </View>
  );
}
