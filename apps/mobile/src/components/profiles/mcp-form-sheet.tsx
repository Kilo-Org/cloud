import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import {
  buildMcpServerPayload,
  initialMcpFormState,
  type McpFormError,
  type McpFormType,
  type McpServerPayload,
  type McpServerSource,
  validateMcpForm,
} from '@/components/profiles/profile-mcp-model';
import { SheetHeader } from '@/components/sheet-header';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Text } from '@/components/ui/text';

/** Catalog key for each refused field, so the message lands under the input at fault. */
const ERROR_KEYS = {
  'name-required': 'profiles.mcp.nameRequired',
  'name-invalid': 'profiles.mcp.nameInvalid',
  'command-required': 'profiles.mcp.commandRequired',
  'url-required': 'profiles.mcp.urlRequired',
  'url-invalid': 'profiles.mcp.urlInvalid',
  'timeout-invalid': 'profiles.mcp.timeoutInvalid',
  'json-invalid': 'profiles.mcp.jsonInvalid',
} satisfies Record<McpFormError, string>;

function errorKeyFor(
  t: (key: string) => string,
  error: McpFormError | null,
  match: readonly McpFormError[]
): string | undefined {
  return error !== null && match.includes(error) ? t(ERROR_KEYS[error]) : undefined;
}

type McpFormSheetProps = Readonly<{
  /** The server being edited, or `null` when adding one. */
  server: McpServerSource | null;
  isSaving: boolean;
  onClose: () => void;
  /**
   * Persist the validated payload. The caller owns create-vs-update and closes
   * the sheet on success; on failure it returns with the sheet still open.
   */
  onSave: (payload: McpServerPayload) => void;
}>;

/**
 * The add/edit MCP server sheet. Mounted only while open, so every open seeds
 * fresh fields from the server it edits. Text fields are uncontrolled (refs),
 * per the app's iOS text-input rule; the type and enabled controls are state.
 *
 * Save validates through `validateMcpForm`; a refused input shows the matching
 * `profiles.mcp.*` message under the field at fault and persists nothing. A
 * local server's env values arrive masked, so the untouched keys round-trip and
 * only retyped values rotate.
 */
export function McpFormSheet({ server, isSaving, onClose, onSave }: Readonly<McpFormSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const initial = initialMcpFormState(server ?? undefined);
  const nameRef = useRef(initial.name);
  const commandRef = useRef(initial.command);
  const urlRef = useRef(initial.url);
  const configRef = useRef(initial.configJson);
  const timeoutRef = useRef(initial.timeout);
  const [type, setType] = useState<McpFormType>(initial.type);
  const [enabled, setEnabled] = useState(initial.enabled);
  const [error, setError] = useState<McpFormError | null>(null);

  const submit = () => {
    const state = {
      name: nameRef.current,
      type,
      enabled,
      command: commandRef.current,
      url: urlRef.current,
      configJson: configRef.current,
      timeout: timeoutRef.current,
    };
    const problem = validateMcpForm(state);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    onSave(buildMcpServerPayload(state));
  };

  const typeOptions = [
    { value: 'local' as const, label: t('profiles.mcp.localType') },
    { value: 'remote' as const, label: t('profiles.mcp.remoteType') },
  ];

  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={server === null ? t('profiles.mcp.add') : server.name}
        onDone={submit}
        onCancel={onClose}
        doneLabel={t('common.save')}
        disabled={isSaving}
        topInset="ios-page-sheet"
      />
      <ScrollView
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <View className="gap-1.5">
          <Text className="text-sm font-medium text-foreground">{t('profiles.mcp.type')}</Text>
          <SegmentedControl
            options={typeOptions}
            value={type}
            onChange={setType}
            accessibilityLabel={t('profiles.mcp.type')}
          />
        </View>

        <FormField
          label={t('profiles.mcp.name')}
          defaultValue={initial.name}
          error={errorKeyFor(t, error, ['name-required', 'name-invalid'])}
          disabled={isSaving}
          required
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.mcp.namePlaceholder')}
          onChangeText={value => {
            nameRef.current = value;
            setError(null);
          }}
        />

        {type === 'local' ? (
          <FormField
            label={t('profiles.mcp.command')}
            defaultValue={initial.command}
            error={errorKeyFor(t, error, ['command-required'])}
            disabled={isSaving}
            required
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('profiles.mcp.commandPlaceholder')}
            onChangeText={value => {
              commandRef.current = value;
              setError(null);
            }}
          />
        ) : (
          <FormField
            label={t('profiles.mcp.url')}
            defaultValue={initial.url}
            error={errorKeyFor(t, error, ['url-required', 'url-invalid'])}
            disabled={isSaving}
            required
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://example.com/mcp"
            onChangeText={value => {
              urlRef.current = value;
              setError(null);
            }}
          />
        )}

        <FormField
          label={type === 'local' ? t('profiles.mcp.environment') : t('profiles.mcp.headers')}
          defaultValue={initial.configJson}
          error={errorKeyFor(t, error, ['json-invalid'])}
          disabled={isSaving}
          multiline
          textAlignVertical="top"
          className="min-h-28 leading-5"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.mcp.jsonPlaceholder')}
          onChangeText={value => {
            configRef.current = value;
            setError(null);
          }}
        />

        <FormField
          label={t('profiles.mcp.timeout')}
          defaultValue={initial.timeout}
          error={errorKeyFor(t, error, ['timeout-invalid'])}
          disabled={isSaving}
          keyboardType="number-pad"
          placeholder="30000"
          onChangeText={value => {
            timeoutRef.current = value;
            setError(null);
          }}
        />

        <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
          <Text className="flex-1 text-sm font-medium text-foreground">{t('common.enabled')}</Text>
          <Switch
            value={enabled}
            disabled={isSaving}
            accessibilityLabel={t('common.enabled')}
            onValueChange={setEnabled}
          />
        </View>
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
