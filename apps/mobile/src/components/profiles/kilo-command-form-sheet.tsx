import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import {
  buildKiloCommandCreatePayload,
  buildKiloCommandUpdatePayload,
  initialKiloCommandFormState,
  type KiloCommandCreatePayload,
  type KiloCommandFormError,
  type KiloCommandFormState,
  type KiloCommandSource,
  type KiloCommandUpdatePayload,
  MAX_KILO_COMMAND_DESCRIPTION_LENGTH,
  MAX_KILO_COMMAND_NAME_LENGTH,
  MAX_KILO_COMMAND_TEMPLATE_LENGTH,
  validateKiloCommandForm,
} from '@/components/profiles/profile-kilo-commands-model';
import { SheetHeader } from '@/components/sheet-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';

/** Catalog key for each refused field, so the message lands under the input at fault. */
const ERROR_KEYS = {
  'name-required': 'profiles.slashCommands.nameRequired',
  'name-invalid': 'profiles.slashCommands.nameInvalid',
  'name-conflict': 'profiles.slashCommands.nameConflict',
  'duplicate-name': 'profiles.slashCommands.duplicateName',
  'template-required': 'profiles.slashCommands.templateRequired',
} satisfies Record<KiloCommandFormError, string>;

/** The form field each refused input belongs to, so Save can scroll it into view. */
const FIELD_FOR_ERROR = {
  'name-required': 'name',
  'name-invalid': 'name',
  'name-conflict': 'name',
  'duplicate-name': 'name',
  'template-required': 'template',
} satisfies Record<KiloCommandFormError, 'name' | 'template'>;

/**
 * The message under Command name: the field's own refusal when validation
 * refused the name, otherwise a conflict the server reported and validation
 * had nothing to say about — the same guard the MCP and agent sheets use, so a
 * later `template-required` does not pin the previous conflict on this field.
 */
function nameErrorMessage(
  t: (key: string) => string,
  error: KiloCommandFormError | null,
  serverConflict: boolean
): string | undefined {
  if (error !== null && FIELD_FOR_ERROR[error] === 'name') {
    return t(ERROR_KEYS[error]);
  }
  if (error === null && serverConflict) {
    return t(ERROR_KEYS['duplicate-name']);
  }
  return undefined;
}

type KiloCommandFormSheetProps = Readonly<{
  command: KiloCommandSource | null;
  /** Names of the profile's other commands, so a duplicate fails validation inline. */
  existingNames?: readonly string[];
  isSaving: boolean;
  onClose: () => void;
  onCreate: (payload: KiloCommandCreatePayload) => void;
  onUpdate: (payload: KiloCommandUpdatePayload) => void;
  /** A server-side name conflict, shown on the name field like a validation error. */
  nameConflictFromServer?: boolean;
  /** A failure the caller cannot name, shown inside the sheet instead of only a toast. */
  saveFailure?: string | null;
}>;

/**
 * The add/edit slash command sheet. Mounted only while open, so every open
 * seeds fresh fields from the command it edits. Text fields are uncontrolled
 * (refs), per the app's iOS text-input rule; the subtask flag is state.
 *
 * Save validates through `validateKiloCommandForm`; a refused input shows the
 * matching `profiles.slashCommands.*` message under the field at fault. The
 * name field keeps exactly what was typed, so a name outside the server's
 * pattern is refused under the field rather than rewritten into a shorter one
 * the reader never chose. A name the profile already uses is refused here from
 * `existingNames`, and one only the server can detect (a stale list) arrives as
 * `nameConflictFromServer` and shows the same message under the field. Any
 * other refused save arrives as `saveFailure` and renders one line inside the
 * sheet, because a toast behind the open sheet is invisible. Create omits empty
 * optional fields so the DB default applies; update sends `null` so an emptied
 * field clears.
 */
export function KiloCommandFormSheet({
  command,
  existingNames = [],
  isSaving,
  onClose,
  onCreate,
  onUpdate,
  nameConflictFromServer = false,
  saveFailure = null,
}: KiloCommandFormSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const initial = initialKiloCommandFormState(command ?? undefined);
  const nameRef = useRef(initial.name);
  const descriptionRef = useRef(initial.description);
  const templateRef = useRef(initial.template);
  const agentRef = useRef(initial.agent);
  const modelRef = useRef(initial.model);
  const [subtask, setSubtask] = useState(initial.subtask);
  const [error, setError] = useState<KiloCommandFormError | null>(null);
  // The screen raises the server-reported conflict after a refused save; it stays
  // up until the name changes, so it never outlives the input it describes.
  const [serverConflict, setServerConflict] = useState(nameConflictFromServer);
  useEffect(() => {
    if (nameConflictFromServer) {
      setServerConflict(true);
    }
  }, [nameConflictFromServer]);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<'name' | 'template'>();

  const { requestClose, requestDismiss, dialog } = useSheetDismissGuard({
    isDirty: () =>
      nameRef.current !== initial.name ||
      descriptionRef.current !== initial.description ||
      templateRef.current !== initial.template ||
      agentRef.current !== initial.agent ||
      modelRef.current !== initial.model ||
      subtask !== initial.subtask,
    onDiscard: onClose,
  });

  const submit = () => {
    const state: KiloCommandFormState = {
      name: nameRef.current,
      description: descriptionRef.current,
      template: templateRef.current,
      agent: agentRef.current,
      model: modelRef.current,
      subtask,
    };
    const problem = validateKiloCommandForm(state, existingNames);
    if (problem !== null) {
      setError(problem);
      scrollToField(FIELD_FOR_ERROR[problem]);
      return;
    }
    setError(null);
    if (command === null) {
      onCreate(buildKiloCommandCreatePayload(state));
    } else {
      onUpdate(buildKiloCommandUpdatePayload(state));
    }
  };

  const nameError = nameErrorMessage(t, error, serverConflict);

  return (
    <SessionPageSheet visible onClose={onClose} onRequestDismiss={requestDismiss}>
      <SheetHeader
        title={command === null ? t('profiles.slashCommands.add') : command.name}
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
        <FormField
          label={t('profiles.slashCommands.name')}
          defaultValue={initial.name}
          error={nameError}
          disabled={isSaving}
          required
          autoCapitalize="none"
          autoCorrect={false}
          maxLength={MAX_KILO_COMMAND_NAME_LENGTH}
          placeholder={t('profiles.slashCommands.namePlaceholder')}
          containerOnLayout={fieldLayout('name')}
          onChangeText={value => {
            nameRef.current = value;
            setError(null);
            setServerConflict(false);
          }}
        />
        <FormField
          label={t('profiles.slashCommands.description')}
          defaultValue={initial.description}
          disabled={isSaving}
          maxLength={MAX_KILO_COMMAND_DESCRIPTION_LENGTH}
          placeholder={t('profiles.descriptionPlaceholder')}
          onChangeText={value => {
            descriptionRef.current = value;
          }}
        />
        <FormField
          label={t('profiles.slashCommands.template')}
          defaultValue={initial.template}
          error={error === 'template-required' ? t(ERROR_KEYS[error]) : undefined}
          disabled={isSaving}
          required
          multiline
          textAlignVertical="top"
          maxLength={MAX_KILO_COMMAND_TEMPLATE_LENGTH}
          className="min-h-32 max-h-52 leading-[1.25rem]"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.slashCommands.templatePlaceholder')}
          containerOnLayout={fieldLayout('template')}
          onChangeText={value => {
            templateRef.current = value;
            setError(null);
          }}
        />
        <FormField
          label={t('common.agent')}
          defaultValue={initial.agent}
          disabled={isSaving}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.slashCommands.agentPlaceholder')}
          onChangeText={value => {
            agentRef.current = value;
          }}
        />
        <FormField
          label={t('profiles.agents.model')}
          defaultValue={initial.model}
          disabled={isSaving}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.agents.modelPlaceholder')}
          onChangeText={value => {
            modelRef.current = value;
          }}
        />
        <View className="min-h-11 flex-row items-center gap-3 rounded-lg bg-secondary p-3">
          <Text {...HIDDEN_LABEL_PROPS} className="flex-1 text-sm font-medium text-foreground">
            {t('profiles.slashCommands.subtask')}
          </Text>
          <Switch
            value={subtask}
            disabled={isSaving}
            accessibilityLabel={t('profiles.slashCommands.subtask')}
            onValueChange={setSubtask}
          />
        </View>
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
    </SessionPageSheet>
  );
}
