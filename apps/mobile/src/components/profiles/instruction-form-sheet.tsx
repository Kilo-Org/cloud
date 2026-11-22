import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { SessionPageSheet } from '@/components/agents/session-page-sheet';
import {
  instructionContentErrorKey,
  instructionErrorKey,
  instructionNameErrorShown,
  instructionNameHint,
  type InstructionNameHint,
  instructionNameHintKey,
} from '@/components/profiles/instruction-model';
import { SheetHeader } from '@/components/sheet-header';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { FormField } from '@/components/ui/form-field';
import { Text } from '@/components/ui/text';
import { useSheetDismissGuard } from '@/components/ui/use-sheet-dismiss-guard';
import { SCREEN_BODY_CLASS } from '@/lib/layout';
import {
  cleanInstructionName,
  INSTRUCTION_CONTENT_MAX_LENGTH,
  INSTRUCTION_NAME_MAX_LENGTH,
  type InstructionInputError,
  validateInstructionInput,
} from '@/lib/agent-profile-forms';
import { useFormFieldScroll } from '@/lib/hooks/use-form-field-scroll';
import { useSurfaceFeedback } from '@/lib/hooks/use-surface-feedback';
import { useFormDraftRef } from '@/lib/form-draft';
import { settleSaveAttempt } from '@/lib/surface-feedback';

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
   * Returns the save's promise: the sheet holds its one-save admission until
   * the save settles, then releases it, so a failed save can be retried.
   */
  onSave: (submission: InstructionFormSubmission) => Promise<void>;
  /** A refused save, shown inside the sheet instead of only a toast it covers. */
  saveFailure?: string | null;
  /** Whether that failure is an error or an expected limit. */
  saveFailureTone?: 'error' | 'warn';
}>;

type InstructionNameHintLineProps = Readonly<{
  hint: InstructionNameHint;
  /** The field's own error copy, which already states the rule when it shows. */
  nameError: string | undefined;
}>;

/**
 * The one line under the name field: the slug a save will store, or the rule a
 * name must follow when the fold leaves nothing to store. The row keeps one
 * text line's height in every state, with no copy or a transparent copy, so the
 * content field below never moves while the name is typed. The rule goes
 * through `AccessibleStatus`, so a reader using a screen reader hears it while
 * typing instead of at Save, and it stays quiet while the field's own error
 * already states the same sentence.
 */
function InstructionNameHintLine({ hint, nameError }: InstructionNameHintLineProps) {
  const { t } = useTranslation();
  const shown = hint.kind === 'preview' || (hint.kind === 'rule' && nameError === undefined);
  return (
    <View>
      {/* The reserved copy is the longest of the two shown lines and stays
          mounted, so the row's height never depends on which line shows. */}
      <Text
        className="w-full shrink-0 text-xs opacity-0"
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
      >
        {t('profiles.instructionNameInvalid')}
      </Text>
      {shown ? (
        <View className="absolute inset-x-0 top-0">
          {hint.kind === 'preview' ? (
            <Text variant="muted" className="text-xs">
              {t('profiles.instructionNamePreview', { name: hint.slug })}
            </Text>
          ) : (
            <AccessibleStatus
              message={t('profiles.instructionNameInvalid')}
              tone="status"
              className="text-xs"
            />
          )}
        </View>
      ) : null}
    </View>
  );
}

/**
 * The add/edit instruction sheet: a rules file name and its markdown. Mounted
 * only while open, so every open seeds the fields from the instruction it
 * edits. Fields are uncontrolled (refs), per the app's text-input rule.
 *
 * The name is reduced to the server's slug rule on save and the line under the
 * field says so first, so a typed `Release Notes` is never silently stored as
 * another file name. A name with nothing left in ASCII after the fold shows the
 * rule itself there, before Save, because the fold would otherwise leave the
 * field silent on exactly the input the save refuses. Save validates the name as
 * typed through `validateInstructionInput`; a name with nothing left in ASCII
 * after the fold is refused as invalid, not as empty. A refused input shows the
 * matching `profiles.instruction*` message under the field at fault.
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
  const [nameHint, setNameHint] = useState<InstructionNameHint>(() =>
    instructionNameHint(nameRef.current)
  );
  const [error, setError] = useState<InstructionInputError | null>(null);
  // The hint lives in state only because the line under the field renders from
  // it, and a form draft forbids re-rendering on a keystroke that changes
  // nothing. The setter reads the current hint and keeps its object when the
  // new one means the same, so a name that is already a slug costs no render.
  const applyNameHint = (hint: InstructionNameHint) => {
    setNameHint(current =>
      instructionNameHintKey(current) === instructionNameHintKey(hint) ? current : hint
    );
  };
  const { scrollRef, fieldLayout, scrollToField } = useFormFieldScroll<
    'status' | 'name' | 'content'
  >();
  // One save per Save press burst. The admission is taken before validation
  // publishes anything and before `onSave` runs, so a double press in the
  // render window before `isSaving` reaches the Done control starts one save.
  // It rides the save promise: released when the save settles, whatever its
  // outcome, so a refused save can be retried with Save.
  const { feedback, begin } = useSurfaceFeedback<never>();

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
    // `isSaving` alone lags one render, so the burst window reads as idle; the
    // pending admission closes that window at once.
    isRunning: () => isSaving || feedback.status === 'pending',
    onDiscard: onClose,
  });

  const submit = () => {
    void runSubmit();
  };

  const runSubmit = async () => {
    // One save per Save press burst: `doneDisabled={isSaving}` only disables
    // Done on the next render, so a second fast press must be refused here
    // instead of starting a second save (see `trigger-create-screen`).
    const attempt = begin();
    if (attempt === null) {
      return;
    }
    const result = validateInstructionInput({
      name: nameRef.current,
      content: contentRef.current,
    });
    if (result !== null) {
      attempt.abandon();
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
    await settleSaveAttempt(attempt, () =>
      onSave({ name: cleanInstructionName(nameRef.current), content: contentRef.current })
    );
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
        contentContainerClassName={SCREEN_BODY_CLASS}
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
            applyNameHint(instructionNameHint(value));
            if (error !== null && instructionNameErrorShown(error)) {
              setError(null);
            }
          }}
        />
        {/* One line under the name field, always mounted and always one line
            tall, so the content field never moves while a name is typed. A
            name that saves as typed leaves the row empty instead of removing
            it. The rule is not repeated while the field's own error already
            says the same sentence. */}
        <View className="-mt-2">
          <InstructionNameHintLine hint={nameHint} nameError={nameError} />
        </View>
        <FormField
          label={t('profiles.instructionContentLabel')}
          defaultValue={contentRef.current}
          error={contentError}
          disabled={isSaving}
          required
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
        <View className="h-3" />
      </ScrollView>
      <View style={{ height: insets.bottom }} className="bg-background" />
      {dialog}
    </SessionPageSheet>
  );
}
