import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import {
  instructionContentErrorKey,
  instructionErrorKey,
  instructionNameErrorShown,
  instructionNamePreview,
} from '@/components/profiles/instruction-model';
import { SheetHeader } from '@/components/sheet-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import {
  cleanInstructionName,
  INSTRUCTION_CONTENT_MAX_LENGTH,
  INSTRUCTION_NAME_MAX_LENGTH,
  type InstructionInputError,
  validateInstructionInput,
} from '@/lib/agent-profile-forms';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { useFormDraftRef } from '@/lib/form-draft';

/** The validated fields a saved instruction is built from. */
export type InstructionFormSubmission = { name: string; content: string };

type InstructionFormSheetProps = Readonly<{
  /**
   * The form draft the fields belong to (see `lib/form-draft`), scoped to the
   * profile by the screen, so a remount reopens the sheet on what was typed.
   */
  draftScope?: string;
  /** The instruction being edited, or `null` when adding a new one. */
  instruction: { name: string; content: string } | null;
  isSaving: boolean;
  onClose: () => void;
  /**
   * Persist the validated fields. The caller owns create-vs-update and closes
   * the sheet on success; on failure it returns with the sheet still open.
   */
  onSave: (submission: InstructionFormSubmission) => void;
  /** A refused save, shown inside the sheet instead of only a toast it covers. */
  saveFailure?: string | null;
  /** Whether that failure is an error or an expected limit. */
  saveFailureTone?: 'error' | 'warn';
}>;

/**
 * The add/edit instruction sheet: a rules file name and its markdown. Mounted
 * only while open, so every open seeds the fields from the instruction it
 * edits. Fields are uncontrolled (refs), per the app's text-input rule.
 *
 * The name is reduced to the server's slug rule on save and the preview under
 * the field says so first, so a typed `Release Notes` is never silently stored
 * as another file name. Save validates the name as typed through
 * `validateInstructionInput`; a name with nothing left in ASCII after the fold
 * is refused as invalid, not as empty. A refused input shows the matching
 * `profiles.instruction*` message under the field at fault.
 */
export function InstructionFormSheet({
  draftScope,
  instruction,
  isSaving,
  onClose,
  onSave,
  saveFailure = null,
  saveFailureTone = 'error',
}: Readonly<InstructionFormSheetProps>) {
  const { t } = useTranslation();
  const insets = useSafeAreaInsets();
  const nameRef = useFormDraftRef(draftScope, 'name', instruction?.name ?? '');
  const contentRef = useFormDraftRef(draftScope, 'content', instruction?.content ?? '');
  const [namePreview, setNamePreview] = useState(() => instructionNamePreview(nameRef.current));
  const [error, setError] = useState<InstructionInputError | null>(null);
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<
    'status' | 'name' | 'content'
  >();

  const nameError =
    error !== null && instructionNameErrorShown(error)
      ? t(instructionErrorKey(error), { max: INSTRUCTION_NAME_MAX_LENGTH })
      : undefined;
  const contentKey = instructionContentErrorKey(error);
  const contentError =
    contentKey === null ? undefined : t(contentKey, { max: INSTRUCTION_CONTENT_MAX_LENGTH });

  const { requestClose, requestDismiss, dialog } = useSheetDismissGuard({
    isDirty: () =>
      nameRef.current !== (instruction?.name ?? '') ||
      contentRef.current !== (instruction?.content ?? ''),
    onDiscard: onClose,
  });

  const submit = () => {
    const result = validateInstructionInput({
      name: nameRef.current,
      content: contentRef.current,
    });
    if (result !== null) {
      setError(result);
      scrollToField(instructionNameErrorShown(result) ? 'name' : 'content');
      return;
    }
    setError(null);
    // A refusal that is already on screen stays mounted, so its layout does not
    // fire again; scroll it back into view for this attempt.
    if (saveFailure !== null) {
      scrollToField('status');
    }
    onSave({ name: cleanInstructionName(nameRef.current), content: contentRef.current });
  };

  return (
    <SessionPageSheet visible onClose={onClose} onRequestDismiss={requestDismiss}>
      <SheetHeader
        title={instruction ? t('profiles.instructionEditTitle') : t('profiles.addInstruction')}
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
        <Text variant="muted">{t('profiles.instructionsHint')}</Text>
        <FormField
          label={t('profiles.instructionNameLabel')}
          defaultValue={nameRef.current}
          error={nameError}
          disabled={isSaving}
          required
          autoCapitalize="none"
          autoCorrect={false}
          returnKeyType="next"
          containerOnLayout={fieldLayout('name')}
          onChangeText={value => {
            nameRef.current = value;
            setNamePreview(instructionNamePreview(value));
            if (error !== null && instructionNameErrorShown(error)) {
              setError(null);
            }
          }}
        />
        {namePreview === null ? null : (
          <Text variant="muted" className="-mt-2 text-xs">
            {t('profiles.instructionNamePreview', { name: namePreview })}
          </Text>
        )}
        <FormField
          label={t('profiles.instructionContentLabel')}
          defaultValue={contentRef.current}
          error={contentError}
          disabled={isSaving}
          multiline
          textAlignVertical="top"
          className="min-h-40 max-h-56 leading-[1.25rem]"
          autoCapitalize="none"
          autoCorrect={false}
          containerOnLayout={fieldLayout('content')}
          onChangeText={value => {
            contentRef.current = value;
            if (error === 'no-content' || error === 'content-too-long') {
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
