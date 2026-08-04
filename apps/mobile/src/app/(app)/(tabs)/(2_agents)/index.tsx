import { useCallback, useEffect } from 'react';
import { Alert } from 'react-native';

import { AgentSessionListScreen } from '@/components/agents/session-list-screen';
import {
  getGitHubInstallReturnOutcome,
  subscribeToGitHubInstallReturnOutcome,
  type GitHubInstallReturnOutcome,
} from '@/lib/github-install-return';

function showReturnOutcome(result: GitHubInstallReturnOutcome) {
  if (!result) {
    return;
  }

  switch (result.kind) {
    case 'success': {
      Alert.alert('GitHub App installed', 'Your repositories are now connected.', [
        { text: 'Continue' },
      ]);
      return;
    }
    case 'pending': {
      Alert.alert(
        'Awaiting admin approval',
        'An organization admin must approve the installation request.',
        [{ text: 'Done' }]
      );
      return;
    }
    case 'error': {
      if (result.code === 'install_state_user_mismatch') {
        Alert.alert(
          'Account mismatch',
          'This connection was started from the Kilo App signed in as a different account. Sign in to the web with that account, or start again from the app.',
          [{ text: 'Back' }]
        );
        return;
      }
      if (result.code === 'not_installation_admin') {
        Alert.alert(
          'Cannot complete installation',
          'Only a GitHub admin of that account can connect it. Ask an organization admin to install Kilo.',
          [{ text: 'Back' }]
        );
        return;
      }
      if (result.code === 'installation_already_claimed') {
        Alert.alert(
          'Cannot complete installation',
          'That GitHub installation is already connected to another Kilo account. Disconnect it there first.',
          [{ text: 'Back' }]
        );
        return;
      }
      Alert.alert(
        'Installation did not complete',
        'The GitHub App installation was not completed. Try again from the app.',
        [{ text: 'Try again' }]
      );
      return;
    }
    default: {
      break;
    }
  }
}

export default function AgentSessionList() {
  const consumeReturnOutcome = useCallback(() => {
    showReturnOutcome(getGitHubInstallReturnOutcome());
  }, []);

  useEffect(() => {
    consumeReturnOutcome();
    return subscribeToGitHubInstallReturnOutcome(consumeReturnOutcome);
  }, [consumeReturnOutcome]);

  return <AgentSessionListScreen />;
}
