import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
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
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';

/** Catalog key for each refused field, so the message lands under the input at fault. */
const ERROR_KEYS = {
  'name-required': 'profiles.mcp.nameRequired',
  'name-invalid': 'profiles.mcp.nameInvalid',
  'name-conflict': 'profiles.mcp.nameConflict',
  'command-required': 'profiles.mcp.commandRequired',
  'command-too-long': 'profiles.mcp.commandTooLong',
  'url-required': 'profiles.mcp.urlRequired',
  'url-invalid': 'profiles.mcp.urlInvalid',
  'url-too-long': 'profiles.mcp.urlTooLong',
  'timeout-invalid': 'profiles.mcp.timeoutInvalid',
  'json-invalid': 'profiles.mcp.jsonInvalid',
  'record-too-large': 'profiles.mcp.jsonTooLarge',
} satisfies Record<McpFormError, string>;

/** The field each refused input belongs to, so Save can scroll it into view. */
const FIELD_FOR_ERROR = {
  'name-required': 'name',
  'name-invalid': 'name',
  'name-conflict': 'name',
  'command-required': 'command',
  'command-too-long': 'command',
  'url-required': 'url',
  'url-invalid': 'url',
  'url-too-long': 'url',
  'timeout-invalid': 'timeout',
  'json-invalid': 'config',
  'record-too-large': 'config',
} satisfies Record<McpFormError, 'name' | 'command' | 'url' | 'config' | 'timeout'>;

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
  /** Names of the profile's other servers, so a duplicate fails validation inline. */
  existingNames: readonly string[];
  isSaving: boolean;
  onClose: () => void;
  /**
   * Persist the validated payload. The caller owns create-vs-update and closes
   * the sheet on success; on failure it returns with the sheet still open.
   */
  onSave: (payload: McpServerPayload) => void;
  /** A server-side name conflict, shown on the name field like a validation error. */
  nameConflictFromServer?: boolean;
  /** A failure the caller cannot name, shown inside the sheet instead of only a toast. */
  saveFailure?: string | null;
}>;

/**
 * The add/edit MCP server sheet. Mounted only while open, so every open seeds
 * fresh fields from the server it edits. Text fields are uncontrolled (refs),
 * per the app's iOS text-input rule; the type and enabled controls are state.
 */
export function McpFormSheet({
  server,
  existingNames,
  isSaving,
  onClose,
  onSave,
  nameConflictFromServer = false,
  saveFailure = null,
}: Readonly<McpFormSheetProps>) {
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
  // The screen raises the server-reported conflict after a refused save; it stays
  // up until the name changes, so it never outlives the input it describes.
  const [serverConflict, setServerConflict] = useState(nameConflictFromServer);
  useEffect(() => {
    if (nameConflictFromServer) {
      setServerConflict(true);
    }
  }, [nameConflictFromServer]);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<
    'name' | 'command' | 'url' | 'config' | 'timeout'
  >();

  const { requestClose, requestDismiss, dialog } = useSheetDismissGuard({
    isDirty: () =>
      nameRef.current !== initial.name ||
      commandRef.current !== initial.command ||
      urlRef.current !== initial.url ||
      configRef.current !== initial.configJson ||
      timeoutRef.current !== initial.timeout ||
      type !== initial.type ||
      enabled !== initial.enabled,
    onDiscard: onClose,
  });

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
    const problem = validateMcpForm(state, existingNames);
    if (problem !== null) {
      setError(problem);
      scrollToField(FIELD_FOR_ERROR[problem]);
      return;
    }
    setError(null);
    onSave(buildMcpServerPayload(state));
  };

  const nameError =
    error === 'name-conflict' || (error === null && serverConflict)
      ? t(ERROR_KEYS['name-conflict'])
      : errorKeyFor(t, error, ['name-required', 'name-invalid']);

  const typeOptions = [
    { value: 'local' as const, label: t('profiles.mcp.localType') },
    { value: 'remote' as const, label: t('profiles.mcp.remoteType') },
  ];

  return (
    <SessionPageSheet visible onClose={onClose} onRequestDismiss={requestDismiss}>
      <SheetHeader
        title={server === null ? t('profiles.mcp.add') : server.name}
        onDone={submit}
        onCancel={requestClose}
        doneLabel={t('common.save')}
        doneDisabled={isSaving}
        topInset="ios-page-sheet"
      />
      <ScrollView
        ref={scrollRef}
        className="flex-1"
        contentContainerClassName="gap-4 px-6 pt-4 pb-8"
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <AccessibleStatus message={saveFailure} className="text-sm" />
        {server === null ? (
          <View className="gap-1.5">
            <Text className="text-sm font-medium text-foreground">{t('profiles.mcp.type')}</Text>
            <SegmentedControl
              options={typeOptions}
              value={type}
              onChange={setType}
              accessibilityLabel={t('profiles.mcp.type')}
            />
          </View>
        ) : null}

        <FormField
          label={t('profiles.mcp.name')}
          defaultValue={initial.name}
          error={nameError}
          disabled={isSaving}
          required
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.mcp.namePlaceholder')}
          containerOnLayout={fieldLayout('name')}
          onChangeText={value => {
            nameRef.current = value;
            setError(null);
            setServerConflict(false);
          }}
        />

        {type === 'local' ? (
          <FormField
            label={t('profiles.mcp.command')}
            defaultValue={initial.command}
            error={errorKeyFor(t, error, ['command-required', 'command-too-long'])}
            disabled={isSaving}
            required
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('profiles.mcp.commandPlaceholder')}
            containerOnLayout={fieldLayout('command')}
            onChangeText={value => {
              commandRef.current = value;
              setError(null);
            }}
          />
        ) : (
          <FormField
            label={t('profiles.mcp.url')}
            defaultValue={initial.url}
            error={errorKeyFor(t, error, ['url-required', 'url-invalid', 'url-too-long'])}
            disabled={isSaving}
            required
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://example.com/mcp"
            containerOnLayout={fieldLayout('url')}
            onChangeText={value => {
              urlRef.current = value;
              setError(null);
            }}
          />
        )}

        <View className="gap-1.5" onLayout={fieldLayout('config')}>
          <FormField
            label={type === 'local' ? t('profiles.mcp.environment') : t('profiles.mcp.headers')}
            defaultValue={initial.configJson}
            error={errorKeyFor(t, error, ['json-invalid', 'record-too-large'])}
            disabled={isSaving}
            multiline
            textAlignVertical="top"
            className="min-h-28 max-h-52 leading-[1.25rem]"
            autoCapitalize="none"
            autoCorrect={false}
            placeholder={t('profiles.mcp.jsonPlaceholder')}
            onChangeText={value => {
              configRef.current = value;
              setError(null);
            }}
          />
          {server !== null ? (
            <Text className="text-xs text-muted-foreground">
              {type === 'local' ? t('profiles.mcp.environmentHint') : t('profiles.mcp.headersHint')}
            </Text>
          ) : null}
        </View>

        <FormField
          label={t('profiles.mcp.timeout')}
          defaultValue={initial.timeout}
          error={errorKeyFor(t, error, ['timeout-invalid'])}
          disabled={isSaving}
          keyboardType="number-pad"
          placeholder="30000"
          containerOnLayout={fieldLayout('timeout')}
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
      {dialog}
    </SessionPageSheet>
  );
}
