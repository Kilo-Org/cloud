import { PERSONAL_SECURITY_SCOPE } from '@kilocode/app-shared/security-agent';
import { type Href, useRouter } from 'expo-router';
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
  contextReady: boolean;
};

export function ProductChoices({ organizationId, contextReady }: Readonly<ProductChoicesProps>) {
  const router = useRouter();
  const { t } = useTranslation();
  const prReviewEnabled = useFeatureFlag(FEATURE_FLAG_PR_REVIEW, true);
  const scope = organizationId ?? PERSONAL_SECURITY_SCOPE;

  // Code Reviewer and Security Agent live in the Profile tab, so a plain push
  // from Home stacks the chosen agent on top of whatever agent screens the
  // Profile tab was last left on. Back then reveals that stale screen (for
  // example the Code Reviewer GitHub connect screen behind a Home-opened
  // Security Agent) instead of returning to Home. Open the agent on the Profile
  // tab, pop the tab's stack to its first screen, then replace that screen with
  // the agent, so the agent is the tab's only screen and Back leaves the tab
  // for Home where the user started. The opening navigate also gives the stack
  // a second route to pop before `dismissAll`, so `dismissAll` is always
  // handled (a POP_TO_TOP on a one-route stack is an unhandled action and
  // surfaces as a development LogBox error over the screen). The three calls
  // are queued in order, so each sees the previous one's state.
  const openProfileAgent = (href: Href) => {
    router.navigate(href);
    router.dismissAll();
    router.replace(href);
  };

  if (!contextReady && !prReviewEnabled) {
    return null;
  }

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
              className="rounded-lg bg-secondary px-3"
              onPress={() => {
                openProfileAgent(getCodeReviewerProfilePath(scope));
              }}
            />
            <ConfigureRow
              icon={ShieldCheck}
              title={t('common.securityAgent')}
              subtitle={t('profile.securityAgentSubtitle')}
              className="rounded-lg bg-secondary px-3"
              last={!prReviewEnabled}
              onPress={() => {
                openProfileAgent(getSecurityAgentPath(scope));
              }}
            />
          </>
        )}
        {prReviewEnabled ? (
          <ConfigureRow
            icon={GitMerge}
            title={t('common.prReview')}
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
