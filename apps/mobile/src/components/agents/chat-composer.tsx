import * as Haptics from 'expo-haptics';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { ArrowUp, Paperclip, Square } from 'lucide-react-native';
import { useCallback, useRef, useState } from 'react';
import {
  ActivityIndicator,
  Keyboard,
  type LayoutChangeEvent,
  Pressable,
  TextInput,
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
import { BlurBar } from '@/components/ui/blur-bar';
import { AGENT_ATTACHMENT_MAX_FILES } from '@/lib/agent-attachments/constants';
import {
  type AgentAttachmentWire,
  useAgentAttachmentUpload,
} from '@/lib/agent-attachments/use-agent-attachment-upload';
import { type ModelOption } from '@/lib/hooks/use-available-models';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';

const TEXT_INPUT_MAX_LINES = 5;
const TEXT_INPUT_LINE_HEIGHT = 20;
const TEXT_INPUT_VERTICAL_PADDING = 24;
const TEXT_INPUT_HORIZONTAL_PADDING = 32;
const TEXT_INPUT_MIN_HEIGHT = TEXT_INPUT_LINE_HEIGHT + TEXT_INPUT_VERTICAL_PADDING;
const TEXT_INPUT_MAX_HEIGHT =
  TEXT_INPUT_LINE_HEIGHT * TEXT_INPUT_MAX_LINES + TEXT_INPUT_VERTICAL_PADDING;

const PAPERCLIP_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;

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
  const upload = useAgentAttachmentUpload({ organizationId });

  const measure = useTextHeight({
    minHeight: TEXT_INPUT_MIN_HEIGHT,
    maxHeight: TEXT_INPUT_MAX_HEIGHT,
    verticalPadding: TEXT_INPUT_VERTICAL_PADDING,
    textContentWidth: inputWidth - TEXT_INPUT_HORIZONTAL_PADDING,
    fontSize: 16,
    lineHeight: TEXT_INPUT_LINE_HEIGHT,
  });

  // The backend requires a non-empty prompt even when attachments are present.
  const canSend = hasText && !disabled && !isStreaming && !isSending;
  const showToolbar = isFocused || hasText || upload.attachments.length > 0;
  // isSending locks the input and attachment controls too — otherwise text or
  // attachments added while the send is in flight get wiped by the success path.
  const toolbarDisabled = disabled || isStreaming || isSending;
  const paperclipDisabled =
    toolbarDisabled || upload.attachments.length >= AGENT_ATTACHMENT_MAX_FILES;

  function handleChangeText(value: string) {
    textRef.current = value;
    measure.setText(value);
    setHasText(value.trim().length > 0);
  }

  async function handleSend() {
    const trimmed = textRef.current.trim();
    if (!trimmed || !canSend) {
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
    setIsSending(true);
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
    } finally {
      setIsSending(false);
    }
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
    fontSize: 16,
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

      {showToolbar ? (
        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(100)}>
          <ChatToolbar
            mode={mode}
            onModeChange={onModeChange}
            model={model}
            variant={variant}
            modelOptions={modelOptions}
            onModelSelect={onModelSelect}
            disabled={toolbarDisabled}
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

      <View className="flex-row items-center p-2.5 px-3">
        {attachmentsEnabled ? (
          <Pressable
            onPress={() => {
              void handleAddAttachment();
            }}
            disabled={paperclipDisabled}
            hitSlop={PAPERCLIP_HIT_SLOP}
            className={cn(
              'h-8 w-8 items-center justify-center rounded-full active:opacity-70',
              paperclipDisabled && 'opacity-50'
            )}
            accessibilityRole="button"
            accessibilityLabel="Add attachment"
            accessibilityState={{ disabled: paperclipDisabled }}
          >
            <Paperclip size={18} color={colors.mutedForeground} />
          </Pressable>
        ) : null}

        <View
          className={cn(
            'mx-2.5 flex-1 overflow-hidden rounded-[20px] border border-border bg-card',
            toolbarDisabled && 'opacity-50'
          )}
          onLayout={handleInputLayout}
        >
          <TextInput
            ref={inputRef}
            placeholder={placeholder}
            placeholderTextColor={colors.mutedForeground}
            multiline
            maxLength={4000}
            onChangeText={handleChangeText}
            onFocus={() => {
              setIsFocused(true);
            }}
            onBlur={() => {
              setIsFocused(false);
            }}
            style={textInputStyle}
            scrollEnabled={measure.height >= TEXT_INPUT_MAX_HEIGHT}
            editable={!toolbarDisabled}
            accessibilityState={{ disabled: toolbarDisabled }}
            returnKeyType="default"
            submitBehavior="newline"
            autoCapitalize="sentences"
            autoCorrect
          />
        </View>

        {isStreaming ? (
          <Pressable
            onPress={handleStop}
            disabled={disabled}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Stop generating"
            accessibilityState={{ disabled }}
            className={cn(
              'h-8 w-8 items-center justify-center rounded-full bg-neutral-400 active:opacity-70 dark:bg-neutral-500',
              disabled && 'opacity-50'
            )}
          >
            <Square size={14} color="white" fill="white" />
          </Pressable>
        ) : (
          <Pressable
            onPress={() => {
              void handleSend();
            }}
            disabled={!canSend}
            hitSlop={6}
            accessibilityRole="button"
            accessibilityLabel="Send message"
            accessibilityState={{ disabled: !canSend, busy: isSending }}
            className={`h-8 w-8 items-center justify-center rounded-full active:opacity-70 ${
              canSend ? 'bg-accent-soft' : 'bg-muted'
            }`}
          >
            {isSending ? (
              <ActivityIndicator size="small" color={colors.mutedForeground} />
            ) : (
              <ArrowUp
                size={18}
                color={canSend ? colors.accentSoftForeground : colors.mutedForeground}
                strokeWidth={2.5}
              />
            )}
          </Pressable>
        )}
      </View>
    </BlurBar>
  );
}
