import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { ERROR_KEYS, errorKeyFor, FIELD_FOR_ERROR } from '@/components/profiles/mcp-form-errors';
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
import { FormFieldLabel } from '@/components/ui/form-field-label';
import { RowGroup } from '@/components/ui/row-group';
import { SegmentedControl } from '@/components/ui/segmented-control';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { MAX_PROFILE_MCP_SERVERS } from '@/lib/agent-profile-forms';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useFormDraftRef, useFormDraftState } from '@/lib/form-draft';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { settleSaveAttempt } from '@/lib/surface-feedback';
import { cn } from '@/lib/utils';

/**
 * The save's refusal: the per-profile server cap, a name the server already
 * has, or any other refusal.
 */
export type McpSaveFailure =
  | { readonly kind: 'limit' }
  | { readonly kind: 'name-conflict' }
  | { readonly kind: 'refused' };

type McpFormSheetProps = Readonly<{
  /**
   * The form draft the fields belong to (see `lib/form-draft`). The screen
   * passes a scope scoped to its profile, so a remount reopens the sheet on
   * what was typed; a caller without one gets fresh fields every mount.
   */
  draftScope?: string;
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
  onSave: (payload: McpServerPayload) => Promise<void>;
  /** The last save refusal, each arm rendered where it belongs in the sheet. */
  saveFailure?: McpSaveFailure | null;
}>;

/**
 * The add/edit MCP server sheet. Mounted only while open, so every open seeds
 * fresh fields from the server it edits. Text fields are uncontrolled (refs),
 * per the app's iOS text-input rule; the type and enabled controls are state.
 * A create the profile's cap refuses arrives as `limit` and renders the cap
 * copy as a warning; any other refused save arrives as `refused` and renders
 * one line inside the sheet; a name only the server can detect arrives as
 * `name-conflict` and shows under the name field.
 */
export function McpFormSheet({
  draftScope,
  server,
  existingNames,
  isSaving,
  onClose,
  onSave,
  saveFailure = null,
}: Readonly<McpFormSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const initial = initialMcpFormState(server ?? undefined);
  const scope = draftScope;
  const nameRef = useFormDraftRef(scope, 'name', initial.name);
  const commandRef = useFormDraftRef(scope, 'command', initial.command);
  const urlRef = useFormDraftRef(scope, 'url', initial.url);
  const configRef = useFormDraftRef(scope, 'config', initial.configJson);
  const timeoutRef = useFormDraftRef(scope, 'timeout', initial.timeout);
  const [type, setType] = useFormDraftState<McpFormType>(scope, 'type', initial.type);
  const [enabled, setEnabled] = useFormDraftState(scope, 'enabled', initial.enabled);
  const [error, setError] = useState<McpFormError | null>(null);
  // The screen raises the server-reported conflict after a refused save; it stays
  // up until the name changes, so it never outlives the input it describes.
  const nameConflictFromServer = saveFailure?.kind === 'name-conflict';
  const [serverConflict, setServerConflict] = useState(nameConflictFromServer);
  useEffect(() => {
    if (nameConflictFromServer) {
      setServerConflict(true);
    }
  }, [nameConflictFromServer]);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<
    'name' | 'command' | 'url' | 'config' | 'timeout'
  >();

  // One save per Save press burst; see `instruction-form-sheet.tsx`. Its
  // pending admission closes the burst window the lagging `isSaving` leaves
  // open, so the dismissal guard reads it too.
  const { feedback, begin } = useSurfaceFeedback<never>();

  const { requestClose, requestDismiss, dialog } = useSheetDismissGuard({
    isDirty: () =>
      nameRef.current !== initial.name ||
      commandRef.current !== initial.command ||
      urlRef.current !== initial.url ||
      configRef.current !== initial.configJson ||
      timeoutRef.current !== initial.timeout ||
      type !== initial.type ||
      enabled !== initial.enabled,
    isRunning: () => isSaving || feedback.status === 'pending',
    onDiscard: onClose,
  });

  const submit = () => {
    void runSubmit();
  };

  const runSubmit = async () => {
    const attempt = begin();
    if (attempt === null) {
      return;
    }
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
      attempt.abandon();
      setError(problem);
      scrollToField(FIELD_FOR_ERROR[problem]);
      return;
    }
    setError(null);
    // The admission rides the save; see `instruction-form-sheet.tsx`.
    await settleSaveAttempt(attempt, () => onSave(buildMcpServerPayload(state)));
  };

  const nameError =
    error === 'name-conflict' || (error === null && serverConflict)
      ? t(ERROR_KEYS['name-conflict'])
      : errorKeyFor(t, error, ['name-required', 'name-invalid']);

  const typeOptions = [
    { value: 'local' as const, label: t('profiles.mcp.localType') },
    { value: 'remote' as const, label: t('profiles.mcp.remoteType') },
  ];

  // The one refusal line: a create past the cap names the cap as a warning, and
  // any other refusal keeps the error tone.
  let refusalMessage: string | null = null;
  let refusalTone: 'warn' | 'error' = 'error';
  if (saveFailure?.kind === 'limit') {
    refusalMessage = t('profiles.mcp.limitReached', { max: MAX_PROFILE_MCP_SERVERS });
    refusalTone = 'warn';
  } else if (saveFailure?.kind === 'refused') {
    refusalMessage = t('profiles.mcp.saveFailed');
  }

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
        contentContainerClassName={SCREEN_BODY_CLASS}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <AccessibleStatus message={refusalMessage} tone={refusalTone} className="text-sm" />
        {server === null ? (
          <View className="gap-1.5">
            <FormFieldLabel label={t('profiles.mcp.type')} />
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
          defaultValue={nameRef.current}
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

        {/*
          The two branches share one tree position, and the field writes its
          `defaultValue` only on mount, so each needs its own identity: without
          the keys the input keeps the text typed for the other type while the
          refs keep theirs. Re-keying remounts it from its own draft.
        */}
        {type === 'local' ? (
          <FormField
            key="command"
            label={t('profiles.mcp.command')}
            defaultValue={commandRef.current}
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
            key="url"
            label={t('profiles.mcp.url')}
            defaultValue={urlRef.current}
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
            defaultValue={configRef.current}
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
            <Text variant="caption">
              {type === 'local' ? t('profiles.mcp.environmentHint') : t('profiles.mcp.headersHint')}
            </Text>
          ) : null}
        </View>

        <FormField
          label={t('profiles.mcp.timeout')}
          defaultValue={timeoutRef.current}
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

        <RowGroup>
          <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}>
            <Text
              {...HIDDEN_LABEL_PROPS}
              className="min-w-0 flex-1 text-sm font-medium text-foreground"
            >
              {t('common.enabled')}
            </Text>
            <Switch
              value={enabled}
              disabled={isSaving}
              accessibilityLabel={t('common.enabled')}
              onValueChange={setEnabled}
            />
          </View>
        </RowGroup>
        <View className="h-3" />
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
    </SessionPageSheet>
  );
}
