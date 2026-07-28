/* eslint-disable @typescript-eslint/promise-function-async, require-await -- Native Alert callbacks settle this Promise asynchronously. */
import { Alert } from 'react-native';

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
      'Exit session?',
      'This stops the running session but keeps its history.',
      [
        {
          text: 'Keep session running',
          style: 'cancel',
          onPress: () => {
            settle(false);
          },
        },
        {
          text: 'Exit session',
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
