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
  },
  gitlab: {
    icon: GitMerge,
    actionIcon: GitMerge,
    label: 'codeReviewer.providerConnect.gitlabAccount',
    title: 'common.connectGitlab',
    errorMessage: 'codeReviewer.providerConnect.gitlabError',
  },
} as const;

/**
 * The disconnected provider's one state: the icon circle, the platform's
 * connect heading, what the connection asks for, and the one action that
 * starts it. A reader the install rule refuses gets the sentence naming who
 * may connect in the description and no action, so the screen never offers a
 * press its role cannot finish.
 */
export function ProviderConnectState<T>({
  scope,
  platform,
  notice,
  onConnected,
}: Readonly<{
  scope: string;
  platform: 'github' | 'gitlab';
  /** Why this reader cannot connect; replaces the action when present. */
  notice?: string;
  onConnected: () => Promise<T>;
}>) {
  const { t } = useTranslation();
  const [connecting, setConnecting] = useState(false);
  const { icon: Icon, actionIcon: ActionIcon, label, title, errorMessage } =
    PLATFORM_CONFIG[platform];

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
      title={t(title)}
      description={notice ?? t('codeReviewer.providerConnect.description', { label: t(label) })}
      action={
        notice ? undefined : (
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
