// Shows the prompt a request names and asks the user to confirm it before a
// session starts.

import { Alert, AppState } from 'react-native';

import { i18n } from '@/i18n';

import { type StartAgentRequest } from './app-action-contract';

/**
 * Resolves once the app is in front of the user.
 *
 * The native dialog is shown through the running app, and a question asked
 * while the app is paused is queued for a resume instead of appearing. Waiting
 * for the active state makes the question appear exactly when the user can
 * answer it; a request answered from a launcher shortcut, the Assistant or an
 * action URL brings the app forward, and one that arrives with the app closed
 * reaches here after it has opened.
 */
async function whenAppIsActive(): Promise<void> {
  if (AppState.currentState === 'active') {
    return;
  }
  const { promise, resolve } = Promise.withResolvers<undefined>();
  const subscription = AppState.addEventListener('change', state => {
    if (state === 'active') {
      subscription.remove();
      resolve(undefined);
    }
  });
  await promise;
}

/**
 * The dialog message: what starts, plus the target the request names, so the
 * user sees the repository the run will work in and the session it continues.
 */
function confirmationMessage(request: StartAgentRequest): string {
  const message = i18n.t('appActions.start.confirmMessage', { prompt: request.prompt });
  const details: string[] = [];
  if (request.repository !== undefined) {
    details.push(`${i18n.t('common.repository')}: ${request.repository}`);
  }
  if (request.sessionId !== undefined) {
    details.push(`${i18n.t('agentChat.session.title')}: ${request.sessionId}`);
  }
  return details.length === 0 ? message : `${message}\n\n${details.join('\n')}`;
}

/**
 * Ask the user to confirm `request`, resolving true when they chose to start
 * it.
 */
export async function confirmStartAgent(request: StartAgentRequest): Promise<boolean> {
  await whenAppIsActive();
  const { promise, resolve } = Promise.withResolvers<boolean>();
  Alert.alert(
    i18n.t('appActions.start.confirmTitle'),
    confirmationMessage(request),
    [
      {
        text: i18n.t('common.cancel'),
        style: 'cancel',
        onPress: () => {
          resolve(false);
        },
      },
      {
        text: i18n.t('agentChat.newSession.startSession'),
        onPress: () => {
          resolve(true);
        },
      },
    ],
    {
      cancelable: true,
      onDismiss: () => {
        resolve(false);
      },
    }
  );
  return promise;
}
