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
}>;

/**
 * The line under the name field: the slug a save will store, in one line. The
 * row is reserved at exactly one line of this catalog's preview copy, with a
 * transparent copy in native layout, so the content field below never moves
 * while the name is typed and the row keeps no second line when it has nothing
 * to show. The rule a name must follow is the name field's own error while the
 * fold leaves nothing to store, so it is not stated here.
 */
function InstructionNameHintLine({ hint }: InstructionNameHintLineProps) {
  const { t } = useTranslation();
  // The sentence the row paints. A name that is blank or already a slug has no
  // preview to paint, so the reserve carries the same catalog sentence with no
  // name folded into it: one line of this catalog's copy either way.
  const preview = t('profiles.instructionNamePreview', {
    name: hint.kind === 'preview' ? hint.slug : '',
  });
  return (
    <View>
      {/* The preview sentence holds the row's height in native layout, invisible
          and cut to one line, so the row is one text line in every state and
          every script: the reserved height is the catalog's own copy, not a
          number of wrapped lines. A long slug cannot grow it, and no state
          leaves a second empty line between the field and the label below. */}
      <Text
        className="text-xs opacity-0"
        numberOfLines={1}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        pointerEvents="none"
      >
        {preview}
      </Text>
      {hint.kind === 'preview' ? (
        <View className="absolute inset-x-0 top-0">
          {/* The preview carries the only information on the line, so it stays
              one line and its ellipsis sits in the middle, the app's treatment
              for an identifier: both ends of the stored file name stay
              readable, including in the catalogs that put the slug last. */}
          <Text variant="muted" className="text-xs" numberOfLines={1} ellipsizeMode="middle">
            {preview}
          </Text>
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
 * rule as the field's own error while it is typed, and Done dims with it,
 * because the fold would otherwise leave the field silent on exactly the input
 * the save refuses. Save validates the name as typed through
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
  // The rule the name must follow, shown as the field's own error while the
  // fold leaves nothing to store: a disabled Done with no message would leave
  // the person nothing to fix. A refused save's own message carries the same
  // sentence or a more specific one, so it wins.
  const ruleError = nameHint.kind === 'rule' ? t(instructionErrorKey('bad-name')) : undefined;
  // Every message the name field can show, reserved as one slot at the field's
  // first focus so an error never moves the form under the keyboard. The keys
  // come from the same mapping the refused-save path reads, so a renamed
  // catalog key cannot leave one path behind.
  const nameErrorMessages = [
    t(instructionErrorKey('empty')),
    t(instructionErrorKey('bad-name')),
    t(instructionErrorKey('reserved')),
    t(instructionErrorKey('too-long'), { max: INSTRUCTION_NAME_MAX_LENGTH }),
  ];
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
        doneDisabled={isSaving || nameHint.kind === 'rule'}
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
          error={nameError ?? ruleError}
          reserveErrorMessages={nameErrorMessages}
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
        {/* The one preview line under the name field, always mounted at one text
            line of this catalog's preview copy, so the content field never moves
            while a name is typed and no state leaves a second empty line. A name
            that is blank or saves as typed leaves the row blank instead of
            removing it. The rule is the field's own error, not this row's. */}
        <View className="-mt-2">
          <InstructionNameHintLine hint={nameHint} />
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
