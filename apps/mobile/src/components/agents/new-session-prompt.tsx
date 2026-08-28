/* eslint-disable max-lines -- The new-session prompt owns its uncontrolled input, starter chips, counter, newline control, voice dictation, and attachment strip end-to-end in one cohesive surface. */
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  AccessibilityInfo,
  Keyboard,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  TextInput as RNTextInput,
  type TextInput,
  type TextInputSelectionChangeEvent,
  type TextStyle,
  useWindowDimensions,
  View,
} from 'react-native';
import { CornerDownLeft } from '@/components/ui/icons';
import { toast } from 'sonner-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';

import { AttachmentPreviewStrip } from '@/components/agents/attachment-preview-strip';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import {
  type ComposerSelection,
  pasteTextIntoComposer,
} from '@/components/agents/composer-paste-text';
import { ChatToolbar } from '@/components/agents/chat-toolbar';
import { useTextHeight } from '@/components/agents/use-text-height';
import {
  NEW_SESSION_PROMPT_CHROME_HEIGHT,
  resolveComposerMaxHeight,
  SESSION_HEADER_HEIGHT,
} from '@/components/agents/chat-composer-input-height';
import { useReturnSendsMessagePreference } from '@/lib/hooks/use-return-sends-message-preference';
import { resolveNewSessionPromptControlState } from '@/components/agents/new-session-prompt-state';
import { NewSessionPromptClone } from '@/components/agents/new-session-prompt-clone';
import { NewSessionPromptControls } from '@/components/agents/new-session-prompt-controls';
import { type NewSessionPromptProps } from '@/components/agents/new-session-prompt-types';
import { QueryError } from '@/components/query-error';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useSharePrefill } from '@/lib/share-prefill';
import { cn } from '@/lib/utils';
import {
  applyVoiceDraftAtSelection,
  type VoiceInputSelection,
} from '@/lib/voice-input/voice-input-draft';
import { useVoiceInput } from '@/lib/voice-input/use-voice-input';
import { describeClassificationFailure } from '@/lib/agent-attachments/validate';
import { AGENT_ATTACHMENT_MAX_BYTES } from '@/lib/agent-attachments/constants';
import {
  hasAnyFailedAttachment,
  isAnyAttachmentUploading,
} from '@/lib/agent-attachments/agent-attachment-types';
import {
  clipboardPasteEmptyMessage,
  useClipboardPaste,
} from '@/lib/agent-attachments/use-clipboard-paste';

const PROMPT_INPUT_DEFAULT_LINES = 3;
const PROMPT_INPUT_LINE_HEIGHT = 24;
const PROMPT_INPUT_FONT_SIZE = 16;
// Must mirror the TextInput's actual padding: py-2 (16 total) and px-2 on
// iOS (16 total) / the 24pt-per-side Android inset (48 total).
const PROMPT_INPUT_VERTICAL_PADDING = 16;
const PROMPT_INPUT_HORIZONTAL_PADDING = Platform.OS === 'android' ? 48 : 16;
const PROMPT_INPUT_ANDROID_HORIZONTAL_INSET = 24;
const PROMPT_INPUT_MAX_CHARS = CLOUD_AGENT_PROMPT_MAX_LENGTH;
/** Minimum pressable size: 44pt on iOS, 48dp on Android (WCAG 2.5.8 AA). */
const PROMPT_HIT_TARGET = Platform.OS === 'android' ? 48 : 44;

type NewSessionPromptComponentProps = NewSessionPromptProps & {
  /**
   * Return (when the Return-sends preference is on) triggers the host's Start
   * flow. Omitted by hosts that have not wired the preference, so Return is a
   * no-op there rather than starting on its own.
   */
  onStartSession?: () => void;
};

/**
 * New-session prompt surface: attachment strip, full-width multiline text
 * input, bottom action row (paperclip leading, voice toggle trailing), and
 * the model/mode toolbar. Owns the prompt ref (for voice input to read), the
 * height-measuring TextInput machinery, and the `useVoiceInput` hook. The
 * route listens to `onChangeText` so the create handler can read the live
 * prompt value after `settleVoiceInputBeforeSubmit` resolves; the attachment,
 * repository, and create flows stay in the route so navigation and tRPC
 * mutations stay colocated.
 */
export function NewSessionPrompt({
  attachments,
  attachmentMax,
  isCreating,
  isModelsError,
  isLoadingModels,
  mode,
  model,
  variant,
  modelOptions,
  onChangeText,
  onModeChange,
  onModelSelect,
  customOptions = [],
  modelLocked = false,
  modelLockLabel,
  onAddAttachment,
  onRemoveAttachment,
  onRetryAttachment,
  onMoveAttachment,
  onReorderAttachments,
  onRefetchModels,
  onPrefillAttachments,
  shareId,
  voiceInputSettlerRef,
  initialPrompt,
  onStartSession,
  isCloneEntry = false,
}: Readonly<NewSessionPromptComponentProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { height: windowHeight, fontScale } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const { returnSendsMessage } = useReturnSendsMessagePreference();
  const [keyboardHeight, setKeyboardHeight] = useState(0);
  const [hasPromptText, setHasPromptText] = useState((initialPrompt ?? '').trim().length > 0);
  const [promptCharacterCount, setPromptCharacterCount] = useState(initialPrompt?.length ?? 0);
  const promptRef = useRef(initialPrompt ?? '');
  const initialPromptRef = useRef(initialPrompt ?? '');
  const promptInputRef = useRef<TextInput>(null);
  // Last caret the input reported. Paste inserts here so the button behaves
  // like the platform paste.
  const promptSelectionRef = useRef<ComposerSelection | null>(null);
  // Selection-aware dictation state: the caret captured at session start, the
  // draft the last speech result produced, and the abort trigger. A user edit
  // (including an IME edit, which fires onChangeText) diverges the live draft
  // from the expected draft, so the next speech result aborts instead of
  // inserting into the edit.
  const voiceBaseDraftRef = useRef('');
  const voiceBaseSelectionRef = useRef<VoiceInputSelection | null>(null);
  const voiceExpectedDraftRef = useRef('');
  // RN 0.86 exposes no IME composition event, so this stays false; the draft
  // divergence above is what aborts dictation when an IME session edits text.
  const isComposingRef = useRef(false);
  const abortVoiceInputRef = useRef<(() => Promise<boolean>) | null>(null);
  const [promptInputWidth, setPromptInputWidth] = useState(0);
  const promptLineHeight = PROMPT_INPUT_LINE_HEIGHT * fontScale;
  const promptMinHeight =
    promptLineHeight * PROMPT_INPUT_DEFAULT_LINES + PROMPT_INPUT_VERTICAL_PADDING;
  const promptMaxHeight = resolveComposerMaxHeight({
    windowHeight,
    safeAreaInsetTop: insets.top,
    safeAreaInsetBottom: insets.bottom,
    keyboardHeight,
    sessionHeaderHeight: SESSION_HEADER_HEIGHT * fontScale,
    composerChromeHeight: NEW_SESSION_PROMPT_CHROME_HEIGHT * fontScale,
    minHeight: promptMinHeight,
  });

  // Track the keyboard's reported height so the remaining-space cap follows it.
  useEffect(() => {
    const showEvent = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const hideEvent = Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide';
    const show = Keyboard.addListener(showEvent, event => {
      setKeyboardHeight(Math.max(event.endCoordinates.height, 0));
    });
    const hide = Keyboard.addListener(hideEvent, () => {
      setKeyboardHeight(0);
    });
    return () => {
      show.remove();
      hide.remove();
    };
  }, []);

  const promptInputStyle = {
    includeFontPadding: false,
    fontSize: PROMPT_INPUT_FONT_SIZE * fontScale,
    lineHeight: promptLineHeight,
    textAlignVertical: 'top',
  } satisfies TextStyle;

  const promptMeasure = useTextHeight({
    minHeight: promptMinHeight,
    maxHeight: promptMaxHeight,
    verticalPadding: PROMPT_INPUT_VERTICAL_PADDING,
    textContentWidth: promptInputWidth - PROMPT_INPUT_HORIZONTAL_PADDING,
    fontSize: PROMPT_INPUT_FONT_SIZE,
    lineHeight: PROMPT_INPUT_LINE_HEIGHT,
    fontScale,
  });

  const promptMeasureSetTextRef = useRef(promptMeasure.setText);
  useEffect(() => {
    promptMeasureSetTextRef.current(initialPromptRef.current);
  }, []);

  const handlePromptChange = useCallback(
    (text: string) => {
      promptRef.current = text;
      promptMeasure.setText(text);
      setHasPromptText(text.trim().length > 0);
      setPromptCharacterCount(text.length);
      onChangeText(text);
    },
    [onChangeText, promptMeasure]
  );

  useSharePrefill({
    shareId,
    inputRef: promptInputRef,
    maxLength: PROMPT_INPUT_MAX_CHARS,
    onChangeText: handlePromptChange,
    addCandidates: onPrefillAttachments,
  });

  const voiceInput = useVoiceInput({
    disabled: isCloneEntry || isCreating,
    getDraft: () => {
      // The controller calls getDraft exactly once, at session start, to
      // snapshot the base draft. Capture the caret at the same instant so the
      // selection-aware insert path knows where to splice the transcript.
      voiceBaseDraftRef.current = promptRef.current;
      voiceBaseSelectionRef.current = promptSelectionRef.current;
      voiceExpectedDraftRef.current = promptRef.current;
      return promptRef.current;
    },
    onDraftChange: draft => {
      const result = applyVoiceDraftAtSelection({
        baseDraft: voiceBaseDraftRef.current,
        baseSelection: voiceBaseSelectionRef.current,
        currentDraft: promptRef.current,
        expectedDraft: voiceExpectedDraftRef.current,
        mergedDraft: draft,
        isComposing: isComposingRef.current,
        input: promptInputRef.current,
        maxLength: PROMPT_INPUT_MAX_CHARS,
        onChangeText: handlePromptChange,
      });
      if (result.kind === 'aborted') {
        // The user edited the live speech range or an IME session is composing:
        // keep their text, stop recognition, and announce the stop once.
        AccessibilityInfo.announceForAccessibility(t('voiceInput.listeningStopped'));
        void abortVoiceInputRef.current?.();
        return;
      }
      voiceExpectedDraftRef.current = result.draft;
    },
  });
  abortVoiceInputRef.current = voiceInput.abort;

  useEffect(() => {
    voiceInputSettlerRef.current = voiceInput.settleBeforeSubmit;
    return () => {
      voiceInputSettlerRef.current = null;
    };
  }, [voiceInput.settleBeforeSubmit, voiceInputSettlerRef]);

  const control = resolveNewSessionPromptControlState({
    attachmentsCount: attachments.length,
    attachmentMax,
    isCreating,
    rawPrompt: promptRef.current,
    voiceInputActive: voiceInput.isActive,
  });

  const { paste: pasteClipboard } = useClipboardPaste({
    addFile: async file => {
      await onPrefillAttachments([file]);
    },
    addText: text => {
      // The hook calls the latest render's callback, so this sees a create or
      // a voice session that started during the clipboard read. Neither may
      // take a draft mutation. `NewSessionPrompt` holds no submit lock, so the
      // button's own disabled rule is the authority.
      if (!control.inputEditable) {
        return;
      }
      promptSelectionRef.current = pasteTextIntoComposer(text, {
        input: promptInputRef.current,
        draft: promptRef.current,
        selection: promptSelectionRef.current,
        maxLength: PROMPT_INPUT_MAX_CHARS,
        onChangeText: handlePromptChange,
      });
    },
    onFailure: reason => {
      toast.error(
        reason === 'empty' ? clipboardPasteEmptyMessage() : describeClassificationFailure(reason)
      );
    },
    maxBytes: AGENT_ATTACHMENT_MAX_BYTES,
  });

  function handlePromptInputLayout(event: LayoutChangeEvent) {
    const nextWidth = Math.max(Math.round(event.nativeEvent.layout.width), 0);
    setPromptInputWidth(current => (current === nextWidth ? current : nextWidth));
  }

  function handlePromptSelectionChange(event: TextInputSelectionChangeEvent) {
    promptSelectionRef.current = event.nativeEvent.selection;
  }

  // Starter chips insert text and focus the input; they never start a session.
  const starterChips = [
    t('agentChat.composer.starterChipBuild'),
    t('agentChat.composer.starterChipFix'),
    t('agentChat.composer.starterChipWriteTests'),
  ];
  const showStarters = !hasPromptText && !isCreating;

  function applyStarter(chip: string) {
    promptInputRef.current?.setNativeProps({
      text: chip,
      selection: { start: chip.length, end: chip.length },
    });
    promptInputRef.current?.focus();
    handlePromptChange(chip);
  }

  function handleInsertNewline() {
    if (!control.inputEditable) {
      return;
    }
    promptSelectionRef.current = pasteTextIntoComposer('\n', {
      input: promptInputRef.current,
      draft: promptRef.current,
      selection: promptSelectionRef.current,
      maxLength: PROMPT_INPUT_MAX_CHARS,
      onChangeText: handlePromptChange,
    });
  }

  // Return (with the Return-sends preference on) starts the session with the
  // same gates as the Start button: a non-empty prompt, an idle form, and no
  // failed or in-flight attachments. A blocked start shows the same error the
  // composer shows for a failed attachment. Voice settlement and the host's
  // model/repository/profile gates run inside `onStartSession` itself.
  function handleReturnSubmit() {
    if (control.createDisabled || promptRef.current.trim().length === 0) {
      return;
    }
    if (hasAnyFailedAttachment(attachments)) {
      toast.error(t('agentChat.composer.removeOrRetryFailed'));
      return;
    }
    if (isAnyAttachmentUploading(attachments)) {
      toast.error(t('agentChat.composer.waitForUploads'));
      return;
    }
    onStartSession?.();
  }

  // Clone entry has no composer: render the models error or the toolbar as a
  // standalone block, never an empty rounded composer card. The input, the
  // attachment strip, the paperclip, the paste button, and voice are unmounted.
  if (isCloneEntry) {
    return (
      <NewSessionPromptClone
        isModelsError={isModelsError}
        modelOptions={modelOptions}
        mode={mode}
        model={model}
        variant={variant}
        onModeChange={onModeChange}
        onModelSelect={onModelSelect}
        customOptions={customOptions}
        modelLocked={modelLocked}
        modelLockLabel={modelLockLabel}
        isLoadingModels={isLoadingModels}
        isCreating={isCreating}
        onRefetchModels={onRefetchModels}
      />
    );
  }

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm shadow-[#0000000D]">
      <AttachmentPreviewStrip
        attachments={attachments}
        onRemove={onRemoveAttachment}
        onRetry={onRetryAttachment}
        onMove={onMoveAttachment}
        onReorder={onReorderAttachments}
      />
      {attachments.some(attachment => attachment.metadataStripFailed === true) ? (
        <AccessibleStatus
          tone="error"
          message={t('agentChat.composer.photoMetadataNotRemoved')}
          className="mb-2 px-4 text-xs"
        />
      ) : null}
      <View className="px-2 pt-2">
        {promptMeasure.measureElement}
        <RNTextInput
          ref={promptInputRef}
          placeholder={t('agentChat.newSession.promptPlaceholder')}
          placeholderTextColor={colors.mutedForeground}
          multiline
          defaultValue={initialPrompt}
          className={cn(
            'w-full px-2 py-2 text-base leading-6 text-foreground',
            isCreating && 'opacity-50'
          )}
          style={[
            promptInputStyle,
            { height: promptMeasure.height },
            Platform.OS === 'android'
              ? { paddingHorizontal: PROMPT_INPUT_ANDROID_HORIZONTAL_INSET }
              : undefined,
          ]}
          onChangeText={handlePromptChange}
          onSelectionChange={handlePromptSelectionChange}
          onLayout={handlePromptInputLayout}
          scrollEnabled={promptMeasure.height >= promptMaxHeight}
          editable={control.inputEditable}
          maxLength={PROMPT_INPUT_MAX_CHARS}
          accessibilityState={{ disabled: control.inputAccessibilityDisabled }}
          returnKeyType={returnSendsMessage ? 'send' : 'default'}
          submitBehavior={returnSendsMessage ? 'submit' : 'newline'}
          onSubmitEditing={returnSendsMessage ? handleReturnSubmit : undefined}
          maxFontSizeMultiplier={1}
          // A shared payload prefills this input, so raising the keyboard on
          // arrival hides the attachment strip and the Start button.
          autoFocus={shareId === undefined || shareId === ''}
        />
        {showStarters ? (
          <View className="flex-row flex-wrap gap-2 px-1 pb-2">
            {starterChips.map(chip => (
              <Pressable
                key={chip}
                onPress={() => {
                  applyStarter(chip);
                }}
                accessibilityRole="button"
                accessibilityLabel={chip}
                style={{ minHeight: PROMPT_HIT_TARGET }}
                className="min-h-11 items-center justify-center rounded-full border border-border bg-card px-3 py-2 active:opacity-70"
              >
                <Text className="text-sm font-normal text-muted-foreground">{chip}</Text>
              </Pressable>
            ))}
          </View>
        ) : null}
        {promptCharacterCount > 0 ? (
          <View className="flex-row justify-end px-1 pb-1">
            <Text
              className="text-xs font-normal text-muted-foreground"
              accessibilityLabel={t('agentChat.composer.charactersRemaining', {
                count: PROMPT_INPUT_MAX_CHARS - promptCharacterCount,
              })}
            >
              {PROMPT_INPUT_MAX_CHARS - promptCharacterCount}
            </Text>
          </View>
        ) : null}
        <NewSessionPromptControls
          control={control}
          voiceInput={voiceInput}
          onAddAttachment={onAddAttachment}
          pasteClipboard={pasteClipboard}
        >
          {returnSendsMessage ? (
            <View className="ml-1">
              <Pressable
                onPress={handleInsertNewline}
                disabled={!control.inputEditable}
                hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                accessibilityRole="button"
                accessibilityLabel={t('agentChat.composer.insertNewline')}
                accessibilityState={{ disabled: !control.inputEditable }}
                style={{ minHeight: PROMPT_HIT_TARGET, minWidth: PROMPT_HIT_TARGET }}
                className={cn(
                  'items-center justify-center rounded-full active:opacity-70',
                  !control.inputEditable && 'opacity-50'
                )}
              >
                <CornerDownLeft size={18} color={colors.mutedForeground} />
              </Pressable>
            </View>
          ) : null}
        </NewSessionPromptControls>
      </View>
      {isModelsError && modelOptions.length === 0 ? (
        <QueryError
          placement="top"
          variant="server"
          title={t('agentChat.newSession.couldNotLoadModels')}
          message={t('agentChat.instancePicker.couldNotLoadDescription')}
          onRetry={() => {
            onRefetchModels();
          }}
          className="border-t border-border py-4"
        />
      ) : (
        <ChatToolbar
          mode={mode}
          onModeChange={onModeChange}
          model={model}
          variant={variant}
          modelOptions={modelOptions}
          onModelSelect={onModelSelect}
          disabled={isCreating}
          isLoadingModels={isLoadingModels}
          customOptions={customOptions}
          modelLocked={modelLocked}
          modelLockLabel={modelLockLabel}
          className="border-t border-border bg-neutral-100 dark:bg-neutral-900 px-3 py-3"
        />
      )}
    </View>
  );
}
