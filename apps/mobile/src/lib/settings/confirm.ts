import { Effect } from 'effect';
import { Alert } from 'react-native';

import { i18n } from '@/i18n';

/**
 * Asks the person to confirm a destructive settings change. Resolves true when
 * they choose Save, false on Cancel, on dismissal, and on a back press.
 *
 * An agent's tool call never reaches the store until this resolves true, so a
 * destructive setting (the trusted-host list) is never changed in silence.
 */
export function confirmSettingChange(summary: string): Effect.Effect<boolean> {
  return Effect.promise(
    // eslint-disable-next-line typescript-eslint/promise-function-async -- the promise settles on the alert button press, not on an await
    () =>
      new Promise<boolean>(resolve => {
        Alert.alert(
          i18n.t('settingsTools.confirmTitle'),
          summary,
          [
            {
              text: i18n.t('common.cancel'),
              style: 'cancel',
              onPress: () => {
                resolve(false);
              },
            },
            {
              text: i18n.t('common.save'),
              onPress: () => {
                resolve(true);
              },
            },
          ],
          {
            cancelable: false,
            onDismiss: () => {
              resolve(false);
            },
          }
        );
      })
  );
}
