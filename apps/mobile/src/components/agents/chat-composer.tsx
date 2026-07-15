import * as Haptics from 'expo-haptics';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { useCallback, useRef, useState } from 'react';
import {
  Keyboard,
  type LayoutChangeEvent,
  type TextInput,
  type TextStyle,
  View,
} from 'react-native';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { toast } from 'sonner-native';

import { AttachmentPreviewStrip } from '@/components/agents/attachment-preview-strip';
import { ChatToolbar } from '@/components/agents/chat-toolbar';
import { type AgentMode } from '@/components/agents/mode-selector';
import { pickAgentAttachments } from '@/components/agents/attachment-picker';
import { useTextHeight } from '@/components/agents/use-text-height';
import { resolveChatComposerControlState } from '@/components/agents/chat-composer-input-state';
import { ChatComposerInputRow } from '@/components/agents/chat-composer-input-row';
import { BlurBar } from '@/components/ui/blur-bar';
import { VoiceInputStatus } from '@/components/voice-input-control';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import {
  type AgentAttachmentWire,
  useAgentAttachmentUpload,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { useVoiceInput } from '@/lib/voice-input/use-voice-input';
import { applyVoiceDraftToInput } from '@/lib/voice-input/voice-input-draft';
import { settleVoiceInputBeforeSubmit } from '@/lib/voice-input/voice-input-submit';

const TEXT_INPUT_MAX_LINES = 5;
const TEXT_INPUT_LINE_HEIGHT = 20;
const TEXT_INPUT_VERTICAL_PADDING = 24;
const TEXT_INPUT_HORIZONTAL_PADDING = 32;
const TEXT_INPUT_MIN_HEIGHT = TEXT_INPUT_LINE_HEIGHT + TEXT_INPUT_VERTICAL_PADDING;
const TEXT_INPUT_MAX_HEIGHT =
  TEXT_INPUT_LINE_HEIGHT * TEXT_INPUT_MAX_LINES + TEXT_INPUT_VERTICAL_PADDING;
const TEXT_INPUT_FONT_SIZE = 16;

type ChatComposerProps = {
  onSend: (text: string, attachments?: AgentAttachmentWire) => void | Promise<void>;
  onStop?: () => void | Promise<void>;
  disabled?: boolean;
  isStreaming?: boolean;
  placeholder?: string;
  mode: AgentMode;
  onModeChange: (mode: AgentMode) => void;
  model: string;
  variant: string;
  modelOptions: ModelOption[];
  onModelSelect: (modelId: string, variant: string) => void;
  organizationId?: string;
  /** Only Cloud Agent sessions can receive attachments. */
  attachmentsEnabled?: boolean;
};

export function ChatComposer({
  onSend,
  onStop,
  disabled = false,
  isStreaming = false,
  placeholder = 'Send a message',
  mode,
  onModeChange,
  model,
  variant,
  modelOptions,
  onModelSelect,
  organizationId,
  attachmentsEnabled = true,
}: Readonly<ChatComposerProps>) {
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const textRef = useRef('');
  const inputRef = useRef<TextInput>(null);
  const [hasText, setHasText] = useState(false);
  const [inputWidth, setInputWidth] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const submissionLockRef = useRef(false);
  const upload = useAgentAttachmentUpload({ organizationId });

  const measure = useTextHeight({
    minHeight: TEXT_INPUT_MIN_HEIGHT,
    maxHeight: TEXT_INPUT_MAX_HEIGHT,
    verticalPadding: TEXT_INPUT_VERTICAL_PADDING,
    textContentWidth: inputWidth - TEXT_INPUT_HORIZONTAL_PADDING,
    fontSize: TEXT_INPUT_FONT_SIZE,
    lineHeight: TEXT_INPUT_LINE_HEIGHT,
  });

  // Compute base composer disabled before the voice hook so voice can react to it.
  const toolbarDisabled = disabled || isStreaming || isSending;
  const voiceDisabled = toolbarDisabled;

  const voiceInput = useVoiceInput({
    disabled: voiceDisabled,
    getDraft: () => textRef.current,
    onDraftChange: draft => {
      applyVoiceDraftToInput({
        input: inputRef.current,
        draft,
        maxLength: 4000,
        onChangeText: handleChangeText,
      });
    },
  });

  const control = resolveChatComposerControlState({
    attachmentsCount: upload.attachments.length,
    attachmentMax: AGENT_ATTACHMENT_MAX_FILES,
    disabled,
    hasText,
    isFocused,
    isSending,
    isStreaming,
    voiceInputActive: voiceInput.isActive,
  });

  function handleChangeText(value: string) {
    textRef.current = value;
    measure.setText(value);
    setHasText(value.trim().length > 0);
  }

  async function handleSend() {
    const trimmed = textRef.current.trim();
    if (!trimmed || !control.canSend) {
      return;
    }
    if (upload.isUploading) {
      toast.error('Wait for attachments to finish uploading.');
      return;
    }
    if (upload.hasFailedAttachments) {
      toast.error('Remove or retry failed attachments first.');
      return;
    }
    if (trimmed.startsWith('/') && upload.attachments.length > 0) {
      toast.error('Attachments cannot be sent with slash commands.');
      return;
    }

    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    const payload = upload.toWirePayload();
    try {
      // Only clear the draft once the send actually succeeds — a failed
      // send must leave the text and attachments exactly as the user left
      // them (the parent already surfaces the error toast).
      await onSend(trimmed, payload);
      textRef.current = '';
      setHasText(false);
      measure.reset();
      inputRef.current?.clear();
      upload.reset();
      Keyboard.dismiss();
    } catch {
      // Draft preserved; error already surfaced by the caller.
    }
  }

  async function submit() {
    await settleVoiceInputBeforeSubmit({
      lock: submissionLockRef,
      onPendingChange: setIsSending,
      settleVoiceInput: voiceInput.settleBeforeSubmit,
      submit: handleSend,
    });
  }

  function handleStop() {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void onStop?.();
  }

  function handleInputLayout(event: LayoutChangeEvent) {
    const nextWidth = Math.max(Math.round(event.nativeEvent.layout.width), 0);
    setInputWidth(current => (current === nextWidth ? current : nextWidth));
  }

  const { addCandidates, removeAttachment, retryAttachment } = upload;

  const handleAddAttachment = useCallback(async () => {
    addCandidates(await pickAgentAttachments(showActionSheetWithOptions));
  }, [addCandidates, showActionSheetWithOptions]);

  const textInputStyle: TextStyle = {
    color: colors.foreground,
    fontSize: TEXT_INPUT_FONT_SIZE,
    height: measure.height,
    includeFontPadding: false,
    lineHeight: TEXT_INPUT_LINE_HEIGHT,
    paddingHorizontal: 16,
    paddingVertical: 12,
    textAlignVertical: 'top',
    width: '100%',
  };

  return (
    <BlurBar>
      {measure.measureElement}

      {control.showToolbar ? (
        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(100)}>
          <ChatToolbar
            mode={mode}
            onModeChange={onModeChange}
            model={model}
            variant={variant}
            modelOptions={modelOptions}
            onModelSelect={onModelSelect}
            disabled={control.toolbarDisabled}
          />
        </Animated.View>
      ) : null}

      {attachmentsEnabled ? (
        <AttachmentPreviewStrip
          attachments={upload.attachments}
          onRemove={removeAttachment}
          onRetry={retryAttachment}
        />
      ) : null}

      <View className={cn('px-3', voiceInput.status === 'listening' ? 'pb-1' : 'pb-0')}>
        <VoiceInputStatus status={voiceInput.status} />
      </View>

      <ChatComposerInputRow
        attachmentsEnabled={attachmentsEnabled}
        canSend={control.canSend}
        disabled={disabled}
        inputAccessibilityDisabled={control.inputAccessibilityDisabled}
        inputEditable={control.inputEditable}
        inputRef={inputRef}
        isSending={isSending}
        isStreaming={isStreaming}
        maxInputHeight={TEXT_INPUT_MAX_HEIGHT}
        measureHeight={measure.height}
        onAddAttachment={() => {
          void handleAddAttachment();
        }}
        onChangeText={handleChangeText}
        onInputBlur={() => {
          setIsFocused(false);
        }}
        onInputFocus={() => {
          setIsFocused(true);
        }}
        onInputLayout={handleInputLayout}
        onStop={handleStop}
        onSubmit={() => {
          void submit();
        }}
        onToggleVoice={() => {
          void voiceInput.toggle();
        }}
        paperclipDisabled={control.paperclipDisabled}
        placeholder={placeholder}
        textInputStyle={textInputStyle}
        voiceDisabled={control.voiceDisabled}
        voiceInputAvailable={voiceInput.available}
        voiceInputStatus={voiceInput.status}
      />
    </BlurBar>
  );
}
