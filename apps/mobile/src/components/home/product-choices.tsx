import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';

import { Section } from '@/components/ui/section';
import { ConfigureRow } from '@/components/ui/configure-row';
import { RowGroup } from '@/components/ui/row-group';
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

  const rows = [
    ...(contextReady
      ? [
          <ConfigureRow
            key="code-reviewer"
            icon={GitPullRequest}
            title={t('common.codeReviewer')}
            subtitle={t('profile.codeReviewerSubtitle')}
            hue="honey"
            onPress={() => {
              router.push(getCodeReviewerProfilePath(scope));
            }}
          />,
          <ConfigureRow
            key="security-agent"
            icon={ShieldCheck}
            title={t('common.securityAgent')}
            subtitle={t('profile.securityAgentSubtitle')}
            hue="honey"
            onPress={() => {
              router.push(getSecurityAgentPath(scope));
            }}
          />,
        ]
      : []),
    <ConfigureRow
      key="pr-review"
      icon={GitMerge}
      title={t('common.prReview')}
      subtitle={t('common.prReviewSubtitle')}
      hue="gold"
      onPress={() => {
        router.push(getPrReviewEntryPath());
      }}
    />,
  ];

  return (
    <Section label={t('home.explore')}>
      <RowGroup leadingTile>{rows}</RowGroup>
    </Section>
  );
}
