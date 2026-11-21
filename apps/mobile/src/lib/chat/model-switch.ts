import { type TFunction } from 'i18next';
import { Alert } from 'react-native';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';

import { requiresBackendDisclosure } from './backend-model-options';
import { chatTargetKind } from './backend-target';

/**
 * Points the next message at another model, asking first when the new target
 * has to be explained: a local model runs on this device, and a remote backend
 * sends the conversation to another provider. The chat keeps its model unless
 * the person confirms.
 *
 * A confirmation that lands after the account changed is dropped. The question
 * was asked in the old session, so an answer to it says nothing about what the
 * new one may reach.
 */
export function switchChatModel({
  currentModel,
  nextModel,
  nextModelName,
  t,
  accept,
}: {
  /** The model the chat sends to now, which decides whether disclosure is due. */
  currentModel: string;
  nextModel: string;
  /** The name shown for `nextModel`, so the alert names what the person picked. */
  nextModelName: string;
  t: TFunction;
  accept: () => void;
}): void {
  if (!requiresBackendDisclosure(currentModel, nextModel)) {
    accept();
    return;
  }
  const epoch = currentAuthEpoch();
  const local = chatTargetKind(nextModel) === 'local';
  Alert.alert(
    t(local ? 'modelChat.localModels.switchTitle' : 'modelChat.backends.switchTitle'),
    t(local ? 'modelChat.localModels.switchMessage' : 'modelChat.backends.switchMessage', {
      name: nextModelName,
    }),
    [
      { text: t('common.cancel'), style: 'cancel' },
      {
        text: t(local ? 'modelChat.localModels.switchConfirm' : 'modelChat.backends.switchConfirm'),
        onPress: () => {
          if (isCurrentAuthEpoch(epoch)) {
            accept();
          }
        },
      },
    ],
    // Android back dismisses, which equals Cancel: the model stays as is.
    { cancelable: true }
  );
}
