import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SectionHeader } from '@/components/home/section-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { GitMerge, GitPullRequest, ShieldCheck } from '@/components/ui/icons';
import { getCodeReviewerProfilePath, getPrReviewEntryPath } from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';

type ProductChoicesProps = {
  organizationId: string | null;
  contextReady: boolean;
};

export function ProductChoices({ organizationId, contextReady }: Readonly<ProductChoicesProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const scope = organizationId ?? PERSONAL_SECURITY_SCOPE;

  return (
    <View>
      <SectionHeader label={t('home.explore')} />
      <View className="mx-4 gap-2">
        {contextReady && (
          <>
            <ConfigureRow
              icon={GitPullRequest}
              title={t('common.codeReviewer')}
              subtitle={t('profile.codeReviewerSubtitle')}
              hue="honey"
              className="rounded-lg bg-secondary px-3"
              onPress={() => {
                router.push(getCodeReviewerProfilePath(scope));
              }}
            />
            <ConfigureRow
              icon={ShieldCheck}
              title={t('common.securityAgent')}
              subtitle={t('profile.securityAgentSubtitle')}
              hue="honey"
              className="rounded-lg bg-secondary px-3"
              onPress={() => {
                router.push(getSecurityAgentPath(scope));
              }}
            />
          </>
        )}
        <ConfigureRow
          icon={GitMerge}
          title={t('common.prReview')}
          subtitle={t('profile.prReviewSubtitle')}
          hue="gold"
          className="rounded-lg bg-secondary px-3"
          last
          onPress={() => {
            router.push(getPrReviewEntryPath());
          }}
        />
      </View>
    </View>
  );
}
