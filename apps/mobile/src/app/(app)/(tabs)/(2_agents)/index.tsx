import { useCallback, useEffect } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { Alert, Platform } from 'react-native';

import { i18n } from '@/i18n';
import { AgentSessionListScreen } from '@/components/agents/session-list-screen';
import { getGitHubIntegrationUrl } from '@/lib/agent-github-integration';
import { WEB_BASE_URL } from '@/lib/config';
import {
  getGitHubInstallReturnOutcome,
  type GitHubInstallReturnOutcome,
  subscribeToGitHubInstallReturnOutcome,
} from '@/lib/github-install-return';
import { trpcClient } from '@/lib/trpc';

export type GitHubInstallOutcomeAlertButton = {
  text: string;
  onPress?: () => void;
};

export type GitHubInstallOutcomeAlert = {
  title: string;
  message: string;
  buttons: GitHubInstallOutcomeAlertButton[];
};

/**
 * C13 plan outcome states for the agents tab: happy, retryable unhappy,
 * non-retryable unhappy, and empty (no outcome → null, no alert).
 * The retryable state wires `onRetry` onto the `Try again` button so the
 * alert is a real recovery action, not an inert dismiss.
 */
export function buildGitHubInstallOutcomeAlert(
  result: GitHubInstallReturnOutcome,
  onRetry: () => void
): GitHubInstallOutcomeAlert | null {
  if (!result) {
    return null;
  }

  switch (result.kind) {
    case 'success': {
      return {
        title: i18n.t('agents.githubInstall.installedTitle'),
        message: i18n.t('agents.githubInstall.installedMessage'),
        buttons: [{ text: i18n.t('common.continue') }],
      };
    }
    case 'pending': {
      return {
        title: i18n.t('agents.githubInstall.pendingTitle'),
        message: i18n.t('agents.githubInstall.pendingMessage'),
        buttons: [{ text: i18n.t('common.done') }],
      };
    }
    case 'error': {
      if (result.code === 'install_state_user_mismatch') {
        return {
          title: i18n.t('agents.githubInstall.accountMismatchTitle'),
          message: i18n.t('agents.githubInstall.accountMismatchMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      if (result.code === 'not_installation_admin') {
        return {
          title: i18n.t('agents.githubInstall.cannotCompleteTitle'),
          message: i18n.t('agents.githubInstall.notAdminMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      if (result.code === 'installation_already_claimed') {
        return {
          title: i18n.t('agents.githubInstall.cannotCompleteTitle'),
          message: i18n.t('agents.githubInstall.alreadyClaimedMessage'),
          buttons: [{ text: i18n.t('common.back') }],
        };
      }
      return {
        title: i18n.t('agents.githubInstall.didNotCompleteTitle'),
        message: i18n.t('agents.githubInstall.didNotCompleteMessage'),
        buttons: [{ text: i18n.t('common.tryAgain'), onPress: onRetry }],
      };
    }
    default: {
      return null;
    }
  }
}

/**
 * Recovery for a retryable installation outcome: the consumed C1 install
 * state token is single-use, so mint a fresh one and reopen the web install
 * flow. The flow returns to /cloud/sessions so the outcome can reach this
 * tab again.
 *
 * When the original outcome was org-scoped, the retry mints and reopens the
 * web flow with the same organizationId so the GitHub install stays on the
 * original organization owner.
 */
async function retryGitHubInstall(organizationId?: string): Promise<void> {
  try {
    const { token } = await trpcClient.githubApps.mintInstallState.mutate(
      organizationId
        ? { organizationId, returnTo: '/cloud/sessions' }
        : { returnTo: '/cloud/sessions' }
    );
    const url = getGitHubIntegrationUrl(WEB_BASE_URL, organizationId, token);
    await (Platform.OS === 'android'
      ? WebBrowser.openBrowserAsync(url)
      : WebBrowser.openAuthSessionAsync(url));
  } catch {
    // Mint or browser failure is retryable: keep a working retry action so
    // the user can recover without restarting the whole install flow.
    Alert.alert(
      i18n.t('agents.githubInstall.couldNotOpenTitle'),
      i18n.t('agents.githubInstall.couldNotOpenMessage'),
      [{ text: i18n.t('common.tryAgain'), onPress: () => void retryGitHubInstall(organizationId) }]
    );
  }
}

export default function AgentSessionList() {
  const consumeReturnOutcome = useCallback(() => {
    const result = getGitHubInstallReturnOutcome();
    const alert = buildGitHubInstallOutcomeAlert(result, () => {
      void retryGitHubInstall(result?.organizationId);
    });
    if (alert) {
      Alert.alert(alert.title, alert.message, alert.buttons);
    }
  }, []);

  useEffect(() => {
    consumeReturnOutcome();
    return subscribeToGitHubInstallReturnOutcome(consumeReturnOutcome);
  }, [consumeReturnOutcome]);

  return <AgentSessionListScreen />;
}
