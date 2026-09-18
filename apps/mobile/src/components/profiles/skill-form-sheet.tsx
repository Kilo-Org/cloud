import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { parseSkillMarkdown, skillErrorKey } from '@/components/profiles/skill-markdown';
import { SheetHeader } from '@/components/sheet-header';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { type SkillInputError, validateSkillInput } from '@/lib/agent-profile-forms';

/** The validated fields a saved skill is built from. */
export type SkillFormSubmission = {
  name: string;
  rawMarkdown: string;
  description?: string;
};

type SkillFormSheetProps = Readonly<{
  /** The skill being edited, or `null` when adding a new one. */
  skill: { name: string; rawMarkdown: string } | null;
  isSaving: boolean;
  onClose: () => void;
  /**
   * Persist the validated fields. The caller owns create-vs-update and closes
   * the sheet on success; on failure it returns with the sheet still open.
   */
  onSave: (submission: SkillFormSubmission) => void;
}>;

/**
 * The add/edit skill sheet. Mounted only while open, so every open seeds fresh
 * fields from the skill it edits. Fields are uncontrolled (refs), per the app's
 * iOS text-input rule; the name field remounts via `prefill` when frontmatter
 * in the content fills it in, and never overwrites a name the user typed.
 *
 * Save validates through `validateSkillInput`; a refused input shows the
 * matching `profiles.skill*` message under the field at fault and persists
 * nothing.
 */
export function SkillFormSheet({
  skill,
  isSaving,
  onClose,
  onSave,
}: Readonly<SkillFormSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const nameRef = useRef(skill?.name ?? '');
  const contentRef = useRef(skill?.rawMarkdown ?? '');
  const nameEditedRef = useRef(false);
  const [prefill, setPrefill] = useState(skill?.name ?? '');
  const [error, setError] = useState<SkillInputError | null>(null);

  const nameError = error === 'empty' || error === 'bad-name' ? t(skillErrorKey(error)) : undefined;
  const contentError = error === 'no-content' ? t(skillErrorKey(error)) : undefined;

  const submit = () => {
    const result = validateSkillInput({ name: nameRef.current, content: contentRef.current });
    if (result.error !== null) {
      setError(result.error);
      return;
    }
    setError(null);
    onSave({
      name: nameRef.current.trim(),
      rawMarkdown: contentRef.current,
      ...(result.description === undefined ? {} : { description: result.description }),
    });
  };

  return (
    <SessionPageSheet visible onClose={onClose}>
      <SheetHeader
        title={skill ? t('profiles.skillEditTitle') : t('profiles.addSkill')}
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
        <Text variant="muted">{t('profiles.skillsHint')}</Text>
        <FormField
          key={`skill-name-${prefill}`}
          label={t('profiles.skillNameLabel')}
          defaultValue={prefill}
          error={nameError}
          disabled={isSaving}
          required
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
          onChangeText={value => {
            nameEditedRef.current = true;
            nameRef.current = value;
            if (error === 'empty' || error === 'bad-name') {
              setError(null);
            }
          }}
        />
        <FormField
          label={t('profiles.skillMarkdownLabel')}
          defaultValue={skill?.rawMarkdown ?? ''}
          error={contentError}
          disabled={isSaving}
          multiline
          textAlignVertical="top"
          className="min-h-40 leading-5"
          autoCapitalize="none"
          autoCorrect={false}
          onChangeText={value => {
            contentRef.current = value;
            if (error === 'no-content' && value.trim().length > 0) {
              setError(null);
            }
            if (!nameEditedRef.current) {
              const parsed = parseSkillMarkdown(value);
              if (parsed.name !== undefined && parsed.name.length > 0 && parsed.name !== prefill) {
                nameRef.current = parsed.name;
                setPrefill(parsed.name);
              }
            }
          }}
        />
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
    </SessionPageSheet>
  );
}
