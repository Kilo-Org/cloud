import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, Switch, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import {
  buildKiloCommandCreatePayload,
  buildKiloCommandUpdatePayload,
  initialKiloCommandFormState,
  type KiloCommandFormError,
  type KiloCommandFormState,
  type KiloCommandSource,
  validateKiloCommandForm,
} from '@/components/profiles/profile-kilo-commands-model';
import { SheetHeader } from '@/components/sheet-header';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';

/** Catalog key for each refused field, so the message lands under the input at fault. */
const ERROR_KEYS = {
  'name-required': 'profiles.slashCommands.nameRequired',
  'name-invalid': 'profiles.slashCommands.nameInvalid',
  'name-conflict': 'profiles.slashCommands.nameConflict',
  'template-required': 'profiles.slashCommands.templateRequired',
} satisfies Record<KiloCommandFormError, string>;

/** The create payload the form hands back for a new command. */
export type KiloCommandSubmission = ReturnType<typeof buildKiloCommandCreatePayload>;

type KiloCommandFormSheetProps = Readonly<{
  command: KiloCommandSource | null;
  isSaving: boolean;
  onClose: () => void;
  onCreate: (payload: KiloCommandSubmission) => void;
  onUpdate: (payload: ReturnType<typeof buildKiloCommandUpdatePayload>) => void;
}>;

/**
 * The add/edit slash command sheet. Mounted only while open, so every open
 * seeds fresh fields from the command it edits. Text fields are uncontrolled
 * (refs), per the app's iOS text-input rule; the subtask flag is state.
 *
 * Save validates through `validateKiloCommandForm`; a refused input shows the
 * matching `profiles.slashCommands.*` message under the field at fault. Create
 * omits empty optional fields so the DB default applies; update sends `null` so
 * an emptied field clears.
 */
export function KiloCommandFormSheet({
  command,
  isSaving,
  onClose,
  onCreate,
  onUpdate,
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

  const submit = () => {
    const state: KiloCommandFormState = {
      name: nameRef.current,
      description: descriptionRef.current,
      template: templateRef.current,
      agent: agentRef.current,
      model: modelRef.current,
      subtask,
    };
    const problem = validateKiloCommandForm(state);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setError(null);
    if (command === null) {
      onCreate(buildKiloCommandCreatePayload(state));
    } else {
      onUpdate(buildKiloCommandUpdatePayload(state));
    }
  };

  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={command === null ? t('profiles.slashCommands.add') : command.name}
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
        <FormField
          label={t('profiles.slashCommands.name')}
          defaultValue={initial.name}
          error={
            error === 'name-required' || error === 'name-invalid' || error === 'name-conflict'
              ? t(ERROR_KEYS[error])
              : undefined
          }
          disabled={isSaving}
          required
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.slashCommands.namePlaceholder')}
          onChangeText={value => {
            nameRef.current = value.toLowerCase().replaceAll(/[^a-z0-9-]/g, '');
            setError(null);
          }}
        />
        <FormField
          label={t('profiles.slashCommands.description')}
          defaultValue={initial.description}
          disabled={isSaving}
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
          className="min-h-32 leading-5"
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('profiles.slashCommands.templatePlaceholder')}
          onChangeText={value => {
            templateRef.current = value;
            setError(null);
          }}
        />
        <FormField
          label={t('profiles.slashCommands.agent')}
          defaultValue={initial.agent}
          disabled={isSaving}
          autoCapitalize="none"
          autoCorrect={false}
          placeholder={t('agentChat.modeOptions.code')}
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
          <Text className="flex-1 text-sm font-medium text-foreground">
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
    </SessionPageSheet>
  );
}
