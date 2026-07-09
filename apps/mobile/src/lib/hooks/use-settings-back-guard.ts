import { useNavigation } from 'expo-router';
import { useEffect } from 'react';
import { Alert, type AlertButton } from 'react-native';

import { getSettingsBackGuardOptions } from '@/components/security-agent/settings-screen-state';

const BUTTON_LABEL = {
  save: 'Save',
  discard: 'Discard',
  'keep-editing': 'Keep Editing',
} as const;

/**
 * Shared dirty-screen back handling for Security Agent settings screens.
 * Registers a single `beforeRemove` listener via React Navigation, which
 * fires for every way a screen can be removed — header back, Android
 * hardware back, and the iOS swipe-back gesture — so all three paths get
 * the same confirmation instead of only the header button.
 *
 * Not a general form framework: it only classifies dirty/valid into an
 * alert with up to three buttons and replays the captured navigation
 * action once the user has resolved it.
 */
export function useSettingsBackGuard({
  dirty,
  valid,
  onSave,
}: Readonly<{
  dirty: boolean;
  valid: boolean;
  onSave: () => Promise<void>;
}>) {
  const navigation = useNavigation();

  useEffect(
    () =>
      navigation.addListener('beforeRemove', event => {
        if (!dirty) {
          return;
        }
        event.preventDefault();
        const action = event.data.action;
        const options = getSettingsBackGuardOptions(valid ? 'dirty-valid' : 'dirty-invalid');
        const buttons: AlertButton[] = options.map(option => {
          if (option === 'keep-editing') {
            return { text: BUTTON_LABEL[option], style: 'cancel' };
          }
          if (option === 'discard') {
            return {
              text: BUTTON_LABEL[option],
              style: 'destructive',
              onPress: () => {
                navigation.dispatch(action);
              },
            };
          }
          return {
            text: BUTTON_LABEL[option],
            onPress: () => {
              void (async () => {
                try {
                  await onSave();
                  navigation.dispatch(action);
                } catch {
                  // The save mutation's centralized onError already toasted —
                  // stay on the screen so the user can retry or discard.
                }
              })();
            },
          };
        });
        Alert.alert('Unsaved changes', 'Save your changes before leaving this screen?', buttons);
      }),
    [navigation, dirty, valid, onSave]
  );

  return {
    onBack: () => {
      navigation.goBack();
    },
  };
}
