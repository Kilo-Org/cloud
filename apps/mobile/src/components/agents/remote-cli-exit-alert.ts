/* eslint-disable @typescript-eslint/promise-function-async, require-await -- Native Alert callbacks settle this Promise asynchronously. */
import { Alert } from 'react-native';

export function showRemoteCliExitConfirmation(): Promise<boolean> {
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
      'Exit CLI?',
      'This will stop the CLI on your computer and take all sessions connected to it offline.',
      [
        {
          text: 'Keep CLI running',
          style: 'cancel',
          onPress: () => {
            settle(false);
          },
        },
        {
          text: 'Exit CLI',
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
