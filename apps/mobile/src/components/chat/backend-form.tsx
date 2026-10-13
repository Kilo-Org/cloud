import { type ApiKind } from '@kilocode/harness-sdk';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Alert, View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { currentAuthEpoch, isCurrentAuthEpoch } from '@/lib/auth/auth-epoch';
import { checkBackendConnection, discoverBackendModels } from '@/lib/chat/backend-request';
import {
  BACKEND_INPUT_ERROR_KEYS,
  BackendInputError,
  type BackendModel,
  type ChatBackendDraft,
  type StoredChatBackend,
} from '@/lib/chat/backend-store';
import { normalizeBackendUrl } from '@/lib/chat/backend-url';
import { assertBackendTransport } from '@/lib/chat/backend-transport';

import {
  API_KINDS,
  backendConnectionFromFields,
  backendDraftFromFields,
  type BackendFormFields,
  modelFields,
} from './backend-form-state';
import { BackendHeadersField } from './backend-headers-field';
import { BackendModelRow } from './backend-model-row';

const FAILURE_KEYS = {
  save: 'modelChat.backends.invalidInput',
  discover: 'modelChat.backends.discoveryFailed',
  check: 'modelChat.backends.connectionFailed',
} as const satisfies Record<'save' | 'discover' | 'check', string>;

export function BackendForm({
  backend,
  onSave,
}: Readonly<{ backend?: StoredChatBackend; onSave: (draft: ChatBackendDraft) => void }>) {
  const { t } = useTranslation();
  const epoch = useRef(currentAuthEpoch());
  const [apiKind, setApiKind] = useState<ApiKind>(backend?.apiKind ?? 'chat_completions');
  const [completionTokenField, setCompletionTokenField] = useState<
    BackendFormFields['completionTokenField']
  >(backend?.completionTokenField ?? 'max_completion_tokens');
  const [models, setModels] = useState(() => backend?.models.map(modelFields) ?? []);
  const [discovered, setDiscovered] = useState<BackendModel[]>([]);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const fields = useRef<BackendFormFields>({
    name: backend?.name ?? '',
    baseUrl: backend?.baseUrl ?? '',
    apiKey: backend?.apiKey ?? '',
    headers: JSON.stringify(backend?.headers ?? {}, null, 2),
    apiKind,
    completionTokenField,
    models,
  });
  const approvedUrl = useRef(backend?.allowLocalHttp ? backend.baseUrl : null);
  const pending = useRef<AbortController | null>(null);
  useEffect(() => () => pending.current?.abort(), []);

  const run = async (
    action: 'save' | 'discover' | 'check',
    modelKey?: string,
    approved = false
  ): Promise<void> => {
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
          ]
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
  };

  const addModel = (model?: BackendModel) => {
    if (model && fields.current.models.some(current => current.id.trim() === model.id)) {
      return;
    }
    const next = modelFields(model);
    fields.current.models = [...fields.current.models, next];
    setModels(current => [...current, next]);
    setStatus(null);
  };

  return (
    <View className="gap-4">
      <FormField
        label={t('modelChat.backends.name')}
        defaultValue={fields.current.name}
        disabled={busy}
        onChangeText={name => {
          fields.current.name = name;
        }}
      />
      <FormField
        label={t('modelChat.backends.baseUrl')}
        defaultValue={fields.current.baseUrl}
        keyboardType="url"
        autoCapitalize="none"
        autoCorrect={false}
        disabled={busy}
        onChangeText={baseUrl => {
          fields.current.baseUrl = baseUrl;
          approvedUrl.current = null;
          setStatus(null);
          setDiscovered([]);
        }}
      />
      <Text className="text-sm text-muted-foreground">{t('modelChat.backends.baseUrlHelp')}</Text>
      <Text>{t('modelChat.backends.protocol')}</Text>
      <View className="gap-2">
        {(Object.entries(API_KINDS) as [ApiKind, string][]).map(([kind, label]) => (
          <ChoiceRow
            key={kind}
            label={t(label)}
            selected={apiKind === kind}
            disabled={busy}
            onPress={() => {
              fields.current.apiKind = kind;
              setApiKind(kind);
              setStatus(null);
              setDiscovered([]);
            }}
          />
        ))}
      </View>
      {apiKind === 'chat_completions' && (
        <View className="gap-2">
          <Text>{t('modelChat.backends.completionTokenFieldHelp')}</Text>
          {(['max_completion_tokens', 'max_tokens'] as const).map(field => (
            <ChoiceRow
              key={field}
              label={field}
              selected={completionTokenField === field}
              disabled={busy}
              onPress={() => {
                fields.current.completionTokenField = field;
                setCompletionTokenField(field);
                setStatus(null);
              }}
            />
          ))}
        </View>
      )}
      <FormField
        label={t('modelChat.backends.apiKey')}
        defaultValue={fields.current.apiKey}
        secureTextEntry
        autoCapitalize="none"
        autoCorrect={false}
        disabled={busy}
        onChangeText={apiKey => {
          fields.current.apiKey = apiKey;
          setStatus(null);
          setDiscovered([]);
        }}
      />
      <BackendHeadersField
        defaultValue={fields.current.headers}
        busy={busy}
        onChangeText={headers => {
          fields.current.headers = headers;
          setStatus(null);
          setDiscovered([]);
        }}
      />
      <Text className="text-sm text-muted-foreground">{t('modelChat.backends.headersHelp')}</Text>
      <Button
        variant="outline"
        loading={busy}
        disabled={busy}
        onPress={() => {
          void run('discover');
        }}
      >
        <Text>{t('modelChat.backends.discover')}</Text>
      </Button>
      <Text className="text-sm text-muted-foreground">{t('modelChat.backends.discoveryHelp')}</Text>
      {discovered.map(model => (
        <Button
          key={model.id}
          variant="outline"
          disabled={busy}
          onPress={() => {
            addModel(model);
          }}
        >
          <Text>{t('modelChat.backends.addDiscovered', { model: model.name })}</Text>
        </Button>
      ))}
      <Text>{t('modelChat.backends.models')}</Text>
      <Text className="text-sm text-muted-foreground">{t('modelChat.backends.checkHelp')}</Text>
      {models.map(model => (
        <BackendModelRow
          key={model.key}
          model={model}
          busy={busy}
          onChange={patch => {
            fields.current.models = fields.current.models.map(item =>
              item.key === model.key ? { ...item, ...patch } : item
            );
            setStatus(null);
          }}
          onRemove={() => {
            fields.current.models = fields.current.models.filter(item => item.key !== model.key);
            setModels(current => current.filter(item => item.key !== model.key));
            setStatus(null);
          }}
          onCheck={() => {
            void run('check', model.key);
          }}
        />
      ))}
      <Button
        variant="outline"
        disabled={busy}
        onPress={() => {
          addModel();
        }}
      >
        <Text>{t('modelChat.backends.addModel')}</Text>
      </Button>
      {status !== null && <Text accessibilityRole="alert">{t(status)}</Text>}
      <Button
        disabled={busy}
        onPress={() => {
          void run('save');
        }}
      >
        <Text>{t('common.save')}</Text>
      </Button>
    </View>
  );
}
