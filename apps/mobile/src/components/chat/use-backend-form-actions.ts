import { type Dispatch, type RefObject, type SetStateAction, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert } from 'react-native';

import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { checkBackendConnection, discoverBackendModels } from '@/lib/chat/backend-request';
import {
  BACKEND_INPUT_ERROR_KEYS,
  BackendInputError,
  type BackendModel,
  type ChatBackendDraft,
} from '@/lib/chat/backend-store';
import { normalizeBackendUrl } from '@/lib/chat/backend-url';
import { assertBackendTransport } from '@/lib/chat/backend-transport';

import {
  backendConnectionFromFields,
  backendDraftFromFields,
  type BackendFormFields,
} from './backend-form-state';

const FAILURE_KEYS = {
  save: 'modelChat.backends.invalidInput',
  discover: 'modelChat.backends.discoveryFailed',
  check: 'modelChat.backends.connectionFailed',
} as const satisfies Record<'save' | 'discover' | 'check', string>;

type BackendAction = keyof typeof FAILURE_KEYS;

/**
 * The three actions the backend form's buttons run.
 *
 * `save` hands the draft to the caller; `discover` and `check` talk to the
 * server the fields describe. A local-HTTP endpoint needs the one-off approval
 * dialog before either, and every outcome lands in the form's status line.
 * The form owns the fields and their layout; this hook owns the requests and
 * the state they drive, so both can be read without one standing in for the
 * other.
 */
export function useBackendFormActions({
  fields,
  approvedUrl,
  onSave,
  setBusy,
  setStatus,
  setDiscovered,
}: Readonly<{
  fields: RefObject<BackendFormFields>;
  approvedUrl: RefObject<string | null>;
  onSave: (draft: ChatBackendDraft) => void;
  setBusy: (busy: boolean) => void;
  setStatus: (status: string | null) => void;
  setDiscovered: Dispatch<SetStateAction<BackendModel[]>>;
}>) {
  const { t } = useTranslation();
  const epoch = useRef(currentAuthEpoch());
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  async function run(action: BackendAction, modelKey?: string, approved = false): Promise<void> {
    if (!isCurrentAuthEpoch(epoch.current)) {
      setStatus('modelChat.backends.staleBackend');
      return;
    }
    let allowLocalHttp = approved;
    try {
      assertBackendTransport(fields.current.baseUrl);
      if (
        approvedUrl.current !== null &&
        normalizeBackendUrl(fields.current.baseUrl, true) === approvedUrl.current
      ) {
        allowLocalHttp = true;
      }
      const connection = backendConnectionFromFields(fields.current, allowLocalHttp);
      if (action === 'save') {
        onSave(backendDraftFromFields(fields.current, allowLocalHttp));
        return;
      }
      const controller = new AbortController();
      pending.current?.abort();
      pending.current = controller;
      setBusy(true);
      setStatus(null);
      if (action === 'discover') {
        const found = await discoverBackendModels(connection, controller.signal);
        if (!controller.signal.aborted && isCurrentAuthEpoch(epoch.current)) {
          setDiscovered(found);
          setStatus('modelChat.backends.discoverySucceeded');
        }
      } else {
        const draft = backendDraftFromFields(fields.current, allowLocalHttp);
        const model = fields.current.models.find(item => item.key === modelKey);
        if (!model) {
          throw new BackendInputError('invalidInput');
        }
        await checkBackendConnection(draft, model.id.trim(), { signal: controller.signal });
        if (!controller.signal.aborted && isCurrentAuthEpoch(epoch.current)) {
          setStatus('modelChat.backends.connectionSucceeded');
        }
      }
    } catch (error) {
      if (error instanceof BackendInputError && error.problem === 'httpApprovalRequired') {
        const endpoint = normalizeBackendUrl(fields.current.baseUrl, true);
        const requestedUrl = fields.current.baseUrl;
        Alert.alert(
          t('modelChat.backends.httpTitle'),
          t('modelChat.backends.httpMessage', { endpoint }),
          [
            { text: t('common.cancel'), style: 'cancel' },
            {
              text: t('modelChat.backends.allowHttp'),
              onPress: () => {
                if (!isCurrentAuthEpoch(epoch.current) || fields.current.baseUrl !== requestedUrl) {
                  return;
                }
                approvedUrl.current = endpoint;
                void run(action, modelKey, true);
              },
            },
          ],
          // Android back dismisses, which equals Cancel: the HTTP backend stays
          // unapproved and the caller keeps the failure status.
          { cancelable: true }
        );
      } else {
        setStatus(
          error instanceof BackendInputError
            ? BACKEND_INPUT_ERROR_KEYS[error.problem]
            : FAILURE_KEYS[action]
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return { run };
}
