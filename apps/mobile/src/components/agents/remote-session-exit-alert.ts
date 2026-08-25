/* eslint-disable @typescript-eslint/promise-function-async, require-await -- Native Alert callbacks settle this Promise asynchronously. */
import { Alert } from 'react-native';

import { i18n } from '@/i18n';

export function showRemoteSessionExitConfirmation(): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false;
    const settle = (confirmed: boolean) => {
      if (settled) {
        return;
      }
      settled = true;
      resolve(confirmed);
    };

    Alert.alert(
      i18n.t('agentChat.remoteSession.exitTitle'),
      i18n.t('agentChat.remoteSession.exitMessage'),
      [
        {
          text: i18n.t('agentChat.remoteSession.keepSessionRunning'),
          style: 'cancel',
          onPress: () => {
            settle(false);
          },
        },
        {
          text: i18n.t('agentChat.remoteSession.exitSession'),
          style: 'destructive',
          onPress: () => {
            settle(true);
          },
        },
      ],
      {
        cancelable: true,
        onDismiss: () => {
          settle(false);
        },
      }
    );
  });
}
