import { SSH_CLIENT_FLAG } from '@kilocode/app-shared/feature-flags';
import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { SectionHeader } from '@/components/home/section-header';
import { ConfigureRow } from '@/components/ui/configure-row';
import { GitMerge, GitPullRequest, ShieldCheck, Terminal } from '@/components/ui/icons';
import { useFeatureFlag } from '@/lib/analytics/posthog';
import { getCodeReviewerProfilePath, getPrReviewEntryPath } from '@/lib/profile-agent-navigation';
import { getSecurityAgentPath } from '@/lib/security-agent';
import { useSshFixtureFlag } from '@/lib/ssh/fixture';
import { SSH_HOSTS_ROUTE } from '@/lib/ssh/routes';

type ProductChoicesProps = {
  organizationId: string | null;
  contextReady: boolean;
};

export function ProductChoices({ organizationId, contextReady }: Readonly<ProductChoicesProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const scope = organizationId ?? PERSONAL_SECURITY_SCOPE;
  const remoteFlag = useFeatureFlag(SSH_CLIENT_FLAG, false);
  const fixtureFlag = useSshFixtureFlag();
  const sshEnabled = remoteFlag || fixtureFlag;

  return (
    <View>
      <SectionHeader label={t('home.explore')} reserveLabelAir />
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
        {sshEnabled ? (
          <ConfigureRow
            icon={Terminal}
            title={t('ssh.title')}
            subtitle={t('ssh.subtitle')}
            hue="sage"
            className="rounded-lg bg-secondary px-3"
            onPress={() => {
              router.push(SSH_HOSTS_ROUTE);
            }}
          />
        ) : null}
        <ConfigureRow
          icon={GitMerge}
          title={t('common.prReview')}
          subtitle={t('common.prReviewSubtitle')}
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
