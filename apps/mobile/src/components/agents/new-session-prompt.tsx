import { type RefObject, useCallback, useEffect, useRef, useState } from 'react';
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  TextInput as RNTextInput,
  type TextInput,
  type TextInputSelectionChangeEvent,
  type TextStyle,
  View,
} from 'react-native';
import { Paperclip } from '@/components/ui/icons';
import { toast } from 'sonner-native';

import { AttachmentPreviewStrip } from '@/components/agents/attachment-preview-strip';
import { ComposerPasteButton } from '@/components/agents/composer-paste-button';
import {
  type ComposerSelection,
  pasteTextIntoComposer,
} from '@/components/agents/composer-paste-text';
import { type AgentMode } from '@/components/agents/mode-selector';
import { ChatToolbar } from '@/components/agents/chat-toolbar';
import { useTextHeight } from '@/components/agents/use-text-height';
import { resolveNewSessionPromptControlState } from '@/components/agents/new-session-prompt-state';
import { QueryError } from '@/components/query-error';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { type SessionModelOption } from '@/lib/hooks/use-session-model-options';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { type ModelPickerSelection } from '@/lib/picker-bridge';
import { useSharePrefill } from '@/lib/share-prefill';
import { cn } from '@/lib/utils';
import { applyVoiceDraftToInput } from '@/lib/voice-input/voice-input-draft';
import { useVoiceInput } from '@/lib/voice-input/use-voice-input';
import { VoiceInputButton, VoiceInputStatus } from '@/components/voice-input-control';
import {
  type AgentAttachment,
  type AgentAttachmentCandidate,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { describeClassificationFailure } from '@/lib/agent-attachments/validate';
import { useClipboardPaste } from '@/lib/agent-attachments/use-clipboard-paste';

const PROMPT_INPUT_DEFAULT_LINES = 3;
const PROMPT_INPUT_MAX_LINES = 6;
const PROMPT_INPUT_LINE_HEIGHT = 24;
// Must mirror the TextInput's actual padding: py-2 (16 total) and px-2 on
// iOS (16 total) / the 24pt-per-side Android inset (48 total).
const PROMPT_INPUT_VERTICAL_PADDING = 16;
const PROMPT_INPUT_HORIZONTAL_PADDING = Platform.OS === 'android' ? 48 : 16;
const PROMPT_INPUT_ANDROID_HORIZONTAL_INSET = 24;
const PROMPT_INPUT_MAX_CHARS = 4000;
const PROMPT_INPUT_MIN_HEIGHT =
  PROMPT_INPUT_LINE_HEIGHT * PROMPT_INPUT_DEFAULT_LINES + PROMPT_INPUT_VERTICAL_PADDING;
const PROMPT_INPUT_MAX_HEIGHT =
  PROMPT_INPUT_LINE_HEIGHT * PROMPT_INPUT_MAX_LINES + PROMPT_INPUT_VERTICAL_PADDING;

const promptInputStyle = {
  includeFontPadding: false,
  lineHeight: PROMPT_INPUT_LINE_HEIGHT,
  textAlignVertical: 'top',
} satisfies TextStyle;

type NewSessionPromptProps = {
  attachments: AgentAttachment[];
  attachmentMax: number;
  isCreating: boolean;
  isModelsError: boolean;
  isLoadingModels: boolean;
  mode: AgentMode;
  model: string;
  variant: string;
  modelOptions: (ModelOption | SessionModelOption)[];
  onChangeText: (text: string) => void;
  onModeChange: (mode: AgentMode) => void;
  onModelSelect: (modelId: string, variant: string, pickerSelection?: ModelPickerSelection) => void;
  onAddAttachment: () => void;
  onRemoveAttachment: (id: string) => void;
  onRetryAttachment: (id: string) => void;
  onRefetchModels: () => void;
  onPrefillAttachments: (candidates: AgentAttachmentCandidate[]) => Promise<void>;
  shareId?: string;
  voiceInputSettlerRef: RefObject<(() => Promise<boolean>) | null>;
  /** Optional initial prompt text seeded into the uncontrolled input once on mount. */
  initialPrompt?: string;
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
  onAddAttachment,
  onRemoveAttachment,
  onRetryAttachment,
  onRefetchModels,
  onPrefillAttachments,
  shareId,
  voiceInputSettlerRef,
  initialPrompt,
}: Readonly<NewSessionPromptProps>) {
  const colors = useThemeColors();
  const promptRef = useRef(initialPrompt ?? '');
  const initialPromptRef = useRef(initialPrompt ?? '');
  const promptInputRef = useRef<TextInput>(null);
  // Last caret the input reported. Paste inserts here so the button behaves
  // like the platform paste.
  const promptSelectionRef = useRef<ComposerSelection | null>(null);
  const [promptInputWidth, setPromptInputWidth] = useState(0);
  const promptMeasure = useTextHeight({
    minHeight: PROMPT_INPUT_MIN_HEIGHT,
    maxHeight: PROMPT_INPUT_MAX_HEIGHT,
    verticalPadding: PROMPT_INPUT_VERTICAL_PADDING,
    textContentWidth: promptInputWidth - PROMPT_INPUT_HORIZONTAL_PADDING,
    fontSize: 16,
    lineHeight: PROMPT_INPUT_LINE_HEIGHT,
  });

  const promptMeasureSetTextRef = useRef(promptMeasure.setText);
  useEffect(() => {
    promptMeasureSetTextRef.current(initialPromptRef.current);
  }, []);

  const handlePromptChange = useCallback(
    (text: string) => {
      promptRef.current = text;
      promptMeasure.setText(text);
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
    disabled: isCreating,
    getDraft: () => promptRef.current,
    onDraftChange: draft => {
      applyVoiceDraftToInput({
        input: promptInputRef.current,
        draft,
        maxLength: PROMPT_INPUT_MAX_CHARS,
        onChangeText: handlePromptChange,
      });
    },
  });

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

  const paperclipDisabled = control.paperclipDisabled;

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
    onUnreadable: () => {
      toast.error(describeClassificationFailure('unreadable'));
    },
  });

  function handlePromptInputLayout(event: LayoutChangeEvent) {
    const nextWidth = Math.max(Math.round(event.nativeEvent.layout.width), 0);
    setPromptInputWidth(current => (current === nextWidth ? current : nextWidth));
  }

  function handlePromptSelectionChange(event: TextInputSelectionChangeEvent) {
    promptSelectionRef.current = event.nativeEvent.selection;
  }

  function handlePaperclipPress() {
    onAddAttachment();
  }

  function handleVoiceToggle() {
    void voiceInput.toggle();
  }

  return (
    <View className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm shadow-black/5">
      <AttachmentPreviewStrip
        attachments={attachments}
        onRemove={onRemoveAttachment}
        onRetry={onRetryAttachment}
      />
      <View className="px-2 pt-2">
        {promptMeasure.measureElement}
        <RNTextInput
          ref={promptInputRef}
          placeholder="What would you like to work on?"
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
          scrollEnabled={promptMeasure.height >= PROMPT_INPUT_MAX_HEIGHT}
          editable={control.inputEditable}
          maxLength={PROMPT_INPUT_MAX_CHARS}
          accessibilityState={{ disabled: control.inputAccessibilityDisabled }}
          // A shared payload prefills this input, so raising the keyboard on
          // arrival hides the attachment strip and the Start button.
          autoFocus={shareId === undefined || shareId === ''}
        />
        <View className="flex-row items-center justify-between pb-2">
          <View className="flex-row items-center gap-1">
            <Pressable
              onPress={handlePaperclipPress}
              disabled={paperclipDisabled}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
              className={cn(
                'h-9 w-9 items-center justify-center rounded-full active:opacity-70',
                paperclipDisabled && 'opacity-50'
              )}
              accessibilityRole="button"
              accessibilityLabel="Add attachment"
              accessibilityState={{ disabled: paperclipDisabled }}
            >
              <Paperclip size={18} color={colors.mutedForeground} />
            </Pressable>
            {/* Follows the input, not the paperclip: a full attachment list
                still allows a text paste. */}
            <ComposerPasteButton onPress={pasteClipboard} disabled={!control.inputEditable} />
          </View>
          {voiceInput.available ? (
            <View className="h-9 flex-1 items-center justify-center overflow-hidden px-2">
              <VoiceInputStatus status={voiceInput.status} />
            </View>
          ) : null}
          {voiceInput.available ? (
            <VoiceInputButton
              disabled={control.voiceDisabled}
              size="md"
              status={voiceInput.status}
              onPress={handleVoiceToggle}
            />
          ) : null}
        </View>
      </View>
      {isModelsError && modelOptions.length === 0 ? (
        <QueryError
          placement="top"
          variant="server"
          title="Couldn't load models"
          message="Check your connection and try again."
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
          className="border-t border-border bg-neutral-100 dark:bg-neutral-900 px-3 py-3"
        />
      )}
    </View>
  );
}
