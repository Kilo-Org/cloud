import { useNavigation, useRouter } from 'expo-router';
import { useEffect, useRef } from 'react';
import { Alert, type AlertButton } from 'react-native';

import { getSettingsBackGuardOptions } from '@/components/security-agent/settings-screen-state';
import { getSecurityAgentPath } from '@/lib/security-agent';

const BUTTON_LABEL = {
  save: 'Save changes',
  discard: 'Discard',
  'keep-editing': 'Keep Editing',
} as const;

/**
 * Bounces off a Security Agent settings screen once its config has loaded
 * and `isEnabled` is false. A config save never re-enables the agent on its
 * own, so these screens shouldn't stay reachable while disabled — only the
 * overview screen (`getSecurityAgentPath(scope, 'settings')`) can turn
 * enablement back on.
 */
export function useSecurityAgentSettingsRedirect(scope: string, isEnabled: boolean | undefined) {
  const router = useRouter();
  useEffect(() => {
    if (isEnabled === false) {
      router.replace(getSecurityAgentPath(scope, 'settings'));
    }
  }, [isEnabled, router, scope]);
}

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
  // Keep the latest onSave in a ref so the effect below doesn't depend on it
  // directly — onSave is a fresh closure every render, which would otherwise
  // tear down and re-register the beforeRemove listener on every render.
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

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
                  await onSaveRef.current();
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
    [navigation, dirty, valid]
  );

  return {
    onBack: () => {
      navigation.goBack();
    },
  };
}
