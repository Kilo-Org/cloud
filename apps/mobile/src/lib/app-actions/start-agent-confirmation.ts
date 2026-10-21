/* eslint-disable @typescript-eslint/promise-function-async -- This module wraps Alert.alert in a Promise-returning helper, so promise-function-async applies; marking it async only to satisfy that rule would need `return await`, which this config forbids. */
// Shows the prompt a request names and asks the user to confirm it before a
// session starts.

import { Alert } from 'react-native';

import { i18n } from '@/i18n';

import { type StartAgentRequest } from './app-action-contract';

/**
 * Ask the user to confirm `request`, resolving true when they chose to start
 * it.
 */
export function confirmStartAgent(request: StartAgentRequest): Promise<boolean> {
  const { promise, resolve } = Promise.withResolvers<boolean>();
  Alert.alert(
    i18n.t('appActions.start.confirmTitle'),
    i18n.t('appActions.start.confirmMessage', { prompt: request.prompt }),
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
