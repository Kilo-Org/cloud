import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import { skillErrorKey } from '@/components/profiles/skill-markdown';
import { SheetHeader } from '@/components/sheet-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import {
  type SkillInputError,
  skillNameFromMarkdown,
  validateSkillInput,
} from '@/lib/agent-profile-forms';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { useFormDraftRef, useFormDraftState } from '@/lib/form-draft';

/** The validated fields a saved skill is built from. */
export type SkillFormSubmission = {
  name: string;
  rawMarkdown: string;
  description?: string;
};

type SkillFormSheetProps = Readonly<{
  /**
   * The form draft the fields belong to (see `lib/form-draft`). The screen
   * passes a scope scoped to its profile, so a remount reopens the sheet on
   * what was typed; a caller without one gets fresh fields every mount.
   */
  draftScope?: string;
  /** The skill being edited, or `null` when adding a new one. */
  skill: { name: string; rawMarkdown: string } | null;
  isSaving: boolean;
  onClose: () => void;
  /**
   * Persist the validated fields. The caller owns create-vs-update and closes
   * the sheet on success; on failure it returns with the sheet still open.
   */
  onSave: (submission: SkillFormSubmission) => void;
  /** A refused save, shown inside the sheet instead of only a toast it covers. */
  saveFailure?: string | null;
  /**
   * Whether that failure is an error or an expected limit. A limit is a
   * warning, not a failure, so the two read differently on screen.
   */
  saveFailureTone?: 'error' | 'warn';
}>;

/**
 * The add/edit skill sheet. Mounted only while open, so every open seeds fresh
 * fields from the skill it edits. Fields are uncontrolled (refs), per the app's
 * iOS text-input rule; the name field remounts via `prefill` when frontmatter
 * in the content fills it in, and never overwrites a name the user typed. A
 * filled name is reduced to the server's name rule first, so the field never
 * holds a value Save would refuse.
 *
 * Save validates through `validateSkillInput`; a refused input shows the
 * matching `profiles.skill*` message under the field at fault and persists
 * nothing. A save the server refused arrives as `saveFailure` and renders one
 * line at the top of the form, scrolled into view, so the open sheet never
 * swallows the reason.
 */
export function SkillFormSheet({
  draftScope,
  skill,
  isSaving,
  onClose,
  onSave,
  saveFailure = null,
  saveFailureTone = 'error',
}: Readonly<SkillFormSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const scope = draftScope;
  const nameRef = useFormDraftRef(scope, 'name', skill?.name ?? '');
  const contentRef = useFormDraftRef(scope, 'content', skill?.rawMarkdown ?? '');
  const nameEditedRef = useFormDraftRef(scope, 'nameEdited', false);
  const [prefill, setPrefill] = useFormDraftState(scope, 'prefill', skill?.name ?? '');
  const [error, setError] = useState<SkillInputError | null>(null);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<
    'status' | 'name' | 'content'
  >();

  const nameError = error === 'empty' || error === 'bad-name' ? t(skillErrorKey(error)) : undefined;
  const contentError = error === 'no-content' ? t(skillErrorKey(error)) : undefined;

  const { requestClose, requestDismiss, dialog } = useSheetDismissGuard({
    isDirty: () =>
      nameRef.current !== (skill?.name ?? '') || contentRef.current !== (skill?.rawMarkdown ?? ''),
    onDiscard: onClose,
  });

  const submit = () => {
    const result = validateSkillInput({ name: nameRef.current, content: contentRef.current });
    if (result.error !== null) {
      setError(result.error);
      scrollToField(result.error === 'no-content' ? 'content' : 'name');
      return;
    }
    setError(null);
    // A refusal that is already on screen stays mounted, so its layout does not
    // fire again; scroll it back into view for this attempt.
    if (saveFailure !== null) {
      scrollToField('status');
    }
    onSave({
      name: nameRef.current.trim(),
      rawMarkdown: contentRef.current,
      ...(result.description === undefined ? {} : { description: result.description }),
    });
  };

  return (
    <SessionPageSheet visible onClose={onClose} onRequestDismiss={requestDismiss}>
      <SheetHeader
        title={skill ? t('profiles.skillEditTitle') : t('profiles.addSkill')}
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
        {saveFailure === null ? null : (
          <View
            onLayout={event => {
              fieldLayout('status')(event);
              scrollToField('status');
            }}
          >
            <AccessibleStatus message={saveFailure} tone={saveFailureTone} className="text-sm" />
          </View>
        )}
        <Text variant="muted">{t('profiles.skillsHint')}</Text>
        <FormField
          key={`skill-name-${prefill}`}
          label={t('profiles.skillNameLabel')}
          defaultValue={nameRef.current}
          error={nameError}
          disabled={isSaving}
          required
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
          containerOnLayout={fieldLayout('name')}
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
          defaultValue={contentRef.current}
          error={contentError}
          disabled={isSaving}
          multiline
          textAlignVertical="top"
          className="min-h-40 max-h-52 leading-[1.25rem]"
          autoCapitalize="none"
          autoCorrect={false}
          containerOnLayout={fieldLayout('content')}
          onChangeText={value => {
            contentRef.current = value;
            if (error === 'no-content' && value.trim().length > 0) {
              setError(null);
            }
            if (nameEditedRef.current) {
              return;
            }
            const derived = skillNameFromMarkdown(value);
            if (derived === undefined || derived === prefill) {
              return;
            }
            nameRef.current = derived;
            setPrefill(derived);
            // The field now holds a name the validator accepts, so an error the
            // last save left on the empty field no longer describes it.
            if (error === 'empty' || error === 'bad-name') {
              setError(null);
            }
          }}
        />
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
    </SessionPageSheet>
  );
}
