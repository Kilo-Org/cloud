import { useCallback, useEffect } from 'react';
import * as WebBrowser from 'expo-web-browser';
import { Alert, Platform } from 'react-native';

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
        title: 'GitHub App installed',
        message: 'Your repositories are now connected.',
        buttons: [{ text: 'Continue' }],
      };
    }
    case 'pending': {
      return {
        title: 'Awaiting admin approval',
        message: 'An organization admin must approve the installation request.',
        buttons: [{ text: 'Done' }],
      };
    }
    case 'error': {
      if (result.code === 'install_state_user_mismatch') {
        return {
          title: 'Account mismatch',
          message:
            'This connection was started from the Kilo App signed in as a different account. Sign in to the web with that account, or start again from the app.',
          buttons: [{ text: 'Back' }],
        };
      }
      if (result.code === 'not_installation_admin') {
        return {
          title: 'Cannot complete installation',
          message:
            'Only a GitHub admin of that account can connect it. Ask an organization admin to install Kilo.',
          buttons: [{ text: 'Back' }],
        };
      }
      if (result.code === 'installation_already_claimed') {
        return {
          title: 'Cannot complete installation',
          message:
            'That GitHub installation is already connected to another Kilo account. Disconnect it there first.',
          buttons: [{ text: 'Back' }],
        };
      }
      return {
        title: 'Installation did not complete',
        message: 'The GitHub App installation was not completed. Try again from the app.',
        buttons: [{ text: 'Try again', onPress: onRetry }],
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
      'Could not open GitHub',
      'We could not start the GitHub App setup. Please try again.',
      [{ text: 'Try again', onPress: () => void retryGitHubInstall(organizationId) }]
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
