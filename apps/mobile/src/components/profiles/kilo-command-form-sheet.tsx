import { useState } from 'react';
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
import { RowGroup } from '@/components/ui/row-group';
import { Switch } from '@/components/ui/switch';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { HIDDEN_LABEL_PROPS } from '@/lib/a11y/hidden-label';
import { ROW_TARGET_CLASS } from '@/lib/a11y/tap-target';
import { MAX_PROFILE_KILO_COMMANDS } from '@/lib/agent-profile-forms';
import { useFormDraftRef, useFormDraftState } from '@/lib/form-draft';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import { cn } from '@/lib/utils';

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

/**
 * The save's refusal: the per-profile command cap, a name the server already
 * has, or any other refusal.
 */
export type KiloCommandSaveFailure =
  | { readonly kind: 'limit' }
  | { readonly kind: 'name-conflict' }
  | { readonly kind: 'refused' };

type KiloCommandFormSheetProps = Readonly<{
  /**
   * The scope this form's fields are drafted under, shared with the screen's
   * `useProfileFormDraft`, so a remount reopens the form on what was typed.
   */
  draftScope?: string;
  command: KiloCommandSource | null;
  /** Names of the profile's other commands, so a duplicate fails validation inline. */
  existingNames?: readonly string[];
  isSaving: boolean;
  onClose: () => void;
  onCreate: (payload: KiloCommandCreatePayload) => void;
  onUpdate: (payload: KiloCommandUpdatePayload) => void;
  /** The command's last refusal, each arm rendered where it belongs in the sheet. */
  saveFailure?: KiloCommandSaveFailure | null;
  /** A field changed, so the refusal it corrects no longer applies. */
  onFieldEdited: () => void;
}>;

/**
 * The add/edit slash command sheet. Mounted only while open, so every open
 * seeds fresh fields from the command it edits. Text fields are uncontrolled
 * (refs), per the app's iOS text-input rule; the subtask flag is state. Both the
 * refs and the flag are drafts in `draftScope`, so a remount — Android activity
 * recreation, or the route going away and coming back — reopens the form on what
 * was typed rather than on the server's copy; the screen clears the scope when
 * it opens or closes the form.
 *
 * Save validates through `validateKiloCommandForm`; a refused input shows the
 * matching `profiles.slashCommands.*` message under the field at fault. The
 * name field keeps exactly what was typed, so a name outside the server's
 * pattern is refused under the field rather than rewritten into a shorter one
 * the reader never chose. A name the profile already uses is refused here from
 * `existingNames`, and one only the server can detect (a stale list) arrives in
 * `saveFailure` as `name-conflict` and shows the same message under the field.
 * A create the profile's cap refuses arrives as `limit` and renders the cap
 * copy as a warning; any other refused save arrives as `refused` and renders
 * one line inside the sheet, because a toast behind the open sheet is
 * invisible. Create omits empty optional fields so the DB default applies;
 * update sends `null` so an emptied field clears.
 */
export function KiloCommandFormSheet({
  draftScope,
  command,
  existingNames = [],
  isSaving,
  onClose,
  onCreate,
  onUpdate,
  saveFailure = null,
  onFieldEdited,
}: KiloCommandFormSheetProps) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  // The values the fields are drawn from belong to the open form, not to the
  // query: a refetch can rewrite `command` under the sheet, and `FormField`
  // writes `defaultValue` once at mount. A mount-time snapshot is therefore what
  // the field shows, and the draft fallback `useFormDraftRef` reads, so Save
  // submits exactly the text on screen.
  const [initial] = useState(() => initialKiloCommandFormState(command ?? undefined));
  const scope = draftScope;
  const nameRef = useFormDraftRef(scope, 'name', initial.name);
  const descriptionRef = useFormDraftRef(scope, 'description', initial.description);
  const templateRef = useFormDraftRef(scope, 'template', initial.template);
  const agentRef = useFormDraftRef(scope, 'agent', initial.agent);
  const modelRef = useFormDraftRef(scope, 'model', initial.model);
  const [subtask, setSubtask] = useFormDraftState(scope, 'subtask', initial.subtask);
  const [error, setError] = useState<KiloCommandFormError | null>(null);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<'name' | 'template'>();

  const { requestClose, requestDismiss, dialog } = useSheetDismissGuard({
    isDirty: () =>
      nameRef.current !== initial.name ||
      descriptionRef.current !== initial.description ||
      templateRef.current !== initial.template ||
      agentRef.current !== initial.agent ||
      modelRef.current !== initial.model ||
      subtask !== initial.subtask,
    isRunning: () => isSaving,
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

  const nameError = nameErrorMessage(t, error, saveFailure?.kind === 'name-conflict');
  // The one refusal line: a create past the cap names the cap as a warning, and
  // any other refusal keeps the error tone.
  let refusalMessage: string | null = null;
  let refusalTone: 'warn' | 'error' = 'error';
  if (saveFailure?.kind === 'limit') {
    refusalMessage = t('profiles.slashCommands.limitReached', { max: MAX_PROFILE_KILO_COMMANDS });
    refusalTone = 'warn';
  } else if (saveFailure?.kind === 'refused') {
    refusalMessage = t('profiles.slashCommands.saveFailed');
  }

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
        contentContainerClassName={SCREEN_BODY_CLASS}
        keyboardShouldPersistTaps="handled"
        automaticallyAdjustKeyboardInsets
        showsVerticalScrollIndicator={false}
      >
        <AccessibleStatus message={refusalMessage} tone={refusalTone} className="text-sm" />
        <FormField
          label={t('profiles.slashCommands.name')}
          defaultValue={nameRef.current}
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
            onFieldEdited();
          }}
        />
        <FormField
          label={t('profiles.slashCommands.description')}
          defaultValue={descriptionRef.current}
          disabled={isSaving}
          maxLength={MAX_KILO_COMMAND_DESCRIPTION_LENGTH}
          placeholder={t('profiles.descriptionPlaceholder')}
          onChangeText={value => {
            descriptionRef.current = value;
          }}
        />
        <FormField
          label={t('profiles.slashCommands.template')}
          defaultValue={templateRef.current}
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
          defaultValue={agentRef.current}
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
          defaultValue={modelRef.current}
          disabled={isSaving}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.agents.modelPlaceholder')}
          onChangeText={value => {
            modelRef.current = value;
          }}
        />
        <RowGroup>
          <View className={cn(ROW_TARGET_CLASS, 'flex-row items-center gap-3 px-4 py-3')}>
            <Text {...HIDDEN_LABEL_PROPS} className="min-w-0 flex-1 text-sm font-medium text-foreground">
              {t('profiles.slashCommands.subtask')}
            </Text>
            <Switch
              value={subtask}
              disabled={isSaving}
              accessibilityLabel={t('profiles.slashCommands.subtask')}
              onValueChange={setSubtask}
            />
          </View>
        </RowGroup>
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
    </SessionPageSheet>
  );
}
