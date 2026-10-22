import { type ApiKind } from '@kilocode/harness-sdk';
import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { View } from 'react-native';

import { Button } from '@/components/ui/button';
import { ChoiceRow } from '@/components/ui/choice-row';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import {
  type BackendModel,
  type ChatBackendDraft,
  type StoredChatBackend,
} from '@/lib/chat/backend-store';

import { useBackendFormDirty } from './backend-form-dirty';
import { API_KINDS, type BackendFormFields, modelFields } from './backend-form-state';
import { BackendHeadersField } from './backend-headers-field';
import { BackendModelList } from './backend-model-list';
import { useBackendFormActions } from './use-backend-form-actions';

export function BackendForm({
  backend,
  onSave,
  onDirtyChange,
}: Readonly<{
  backend?: StoredChatBackend;
  onSave: (draft: ChatBackendDraft) => void;
  /** Unsaved edits, so the sheet can ask before Back or Close drops them. */
  onDirtyChange?: (dirty: boolean) => void;
}>) {
  const { t } = useTranslation();
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
  const reportDirty = useBackendFormDirty(fields, onDirtyChange);
  const { run } = useBackendFormActions({
    fields,
    approvedUrl,
    onSave,
    setBusy,
    setStatus,
    setDiscovered,
  });

  const addModel = (model?: BackendModel) => {
    if (model && fields.current.models.some(current => current.id.trim() === model.id)) {
      return;
    }
    const next = modelFields(model);
    fields.current.models = [...fields.current.models, next];
    setModels(current => [...current, next]);
    setStatus(null);
    reportDirty();
  };

  const updateModel = (key: string, patch: Partial<BackendFormFields['models'][number]>) => {
    fields.current.models = fields.current.models.map(item =>
      item.key === key ? { ...item, ...patch } : item
    );
    setStatus(null);
    reportDirty();
  };

  const removeModel = (key: string) => {
    fields.current.models = fields.current.models.filter(item => item.key !== key);
    setModels(current => current.filter(item => item.key !== key));
    setStatus(null);
    reportDirty();
  };

  return (
    <View className="gap-4">
      <FormField
        label={t('modelChat.backends.name')}
        defaultValue={fields.current.name}
        disabled={busy}
        onChangeText={name => {
          fields.current.name = name;
          reportDirty();
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
          reportDirty();
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
              reportDirty();
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
                reportDirty();
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
          reportDirty();
        }}
      />
      <BackendHeadersField
        defaultValue={fields.current.headers}
        busy={busy}
        onChangeText={headers => {
          fields.current.headers = headers;
          setStatus(null);
          setDiscovered([]);
          reportDirty();
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
      <BackendModelList
        models={models}
        busy={busy}
        onChange={updateModel}
        onRemove={removeModel}
        onCheck={key => {
          void run('check', key);
        }}
        onAdd={() => {
          addModel();
        }}
      />
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
