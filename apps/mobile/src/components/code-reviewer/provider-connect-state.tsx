import { GitBranch, GitMerge } from '@/components/ui/icons';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner-native';

import { EmptyState, StateAction } from '@/components/empty-state';
import { GitHubIcon } from '@/components/icons/github-icon';
import { appShellHandoffUrl } from '@/lib/app-shell-handoff';
import { PERSONAL_SCOPE } from '@/lib/hooks/use-code-reviewer';
import {
  openAuthorizationAndWaitForReturn,
  reportLateLaunchFailure,
} from '@/lib/pr-review/connect-gate-platform';

const PLATFORM_CONFIG = {
  github: {
    icon: GitBranch,
    actionIcon: GitHubIcon,
    label: 'codeReviewer.providerConnect.githubApp',
    title: 'common.connectGithub',
    errorMessage: 'codeReviewer.providerConnect.githubError',
    // The brand name the state titles itself with. `common.github` holds the
    // Latin product name, so a translated interface still titles the state with
    // the word the reader sees on the platform itself, and the heading does not
    // grow a second name for the same product.
    brand: 'common.github',
    // The install rule for the GitHub App is narrower than the one for GitLab:
    // only an owner or admin can install it.
    adminOnlyDescription: 'codeReviewer.providerConnect.githubAdminOnlyDescription',
  },
  gitlab: {
    icon: GitMerge,
    actionIcon: GitMerge,
    label: 'codeReviewer.providerConnect.gitlabAccount',
    title: 'common.connectGitlab',
    errorMessage: 'codeReviewer.providerConnect.gitlabError',
    brand: 'common.gitlab',
    // GitLab's account connect already names the role gate in the PR-review
    // connect gate's copy, so the overview reuses that wording rather than
    // adding a second key with the same English string.
    adminOnlyDescription: 'prReview.connect.adminOnlyConnectDescription',
  },
} as const;

/**
 * The disconnected provider's one surface, in two faces. A reader the install
 * rule allows gets the platform's connect heading, what the connection asks
 * for, and the one action that starts it. A reader the rule refuses
 * (`refused`) gets a neutral heading naming the platform and the sentence
 * saying who may connect it, and no action, so the screen never offers a press
 * its role cannot finish. The two faces share the icon circle and the state
 * layout, and the refused face's description is the whole copy: it does not
 * restate what the heading already named.
 */
export function ProviderConnectState<T>({
  scope,
  platform,
  refused = false,
  onConnected,
}: Readonly<{
  scope: string;
  platform: 'github' | 'gitlab';
  /** This reader's role cannot connect the provider: no action, neutral title. */
  refused?: boolean;
  onConnected: () => Promise<T>;
}>) {
  const { t } = useTranslation();
  const [connecting, setConnecting] = useState(false);
  const {
    icon: Icon,
    actionIcon: ActionIcon,
    label,
    title,
    errorMessage,
    brand,
    adminOnlyDescription,
  } = PLATFORM_CONFIG[platform];

  const connect = async () => {
    setConnecting(true);
    try {
      const orgId = scope === PERSONAL_SCOPE ? undefined : scope;
      const url = await appShellHandoffUrl(
        platform === 'github'
          ? { page: 'github-app', ...(orgId ? { organizationId: orgId } : {}) }
          : { page: 'integration', platform: 'gitlab', ...(orgId ? { organizationId: orgId } : {}) }
      );
      const wait = await openAuthorizationAndWaitForReturn(url);
      // A launch that fails after the app's own return edge ended the wait never
      // reaches the catch below.
      reportLateLaunchFailure(wait, {
        onFailure: () => {
          toast.error(t(errorMessage));
        },
      });
      await onConnected();
    } catch {
      toast.error(t(errorMessage));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <EmptyState
      icon={Icon}
      iconSize={28}
      title={
        refused
          ? t('codeReviewer.providerConnect.notConnectedTitle', { platform: t(brand) })
          : t(title)
      }
      description={
        refused
          ? t(adminOnlyDescription)
          : t('codeReviewer.providerConnect.description', { label: t(label) })
      }
      action={
        refused ? undefined : (
          <StateAction
            label={t('common.connect')}
            icon={ActionIcon}
            loading={connecting}
            disabled={connecting}
            onPress={() => {
              void connect();
            }}
          />
        )
      }
    />
  );
}
