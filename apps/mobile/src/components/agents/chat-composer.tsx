/* eslint-disable max-lines -- Composer owns its uncontrolled input, slash suggestions, and submission flow end-to-end.
 * The wiring between the TextInput and SlashCommandSuggestions is covered by
 * Maestro E2E; this app has no @testing-library/react-native dependency, so it
 * is not expressed as a unit test.
 */
import * as Haptics from 'expo-haptics';
import { useActionSheet } from '@expo/react-native-action-sheet';
import { type SlashCommandInfo } from 'cloud-agent-sdk';
import { type RemoteCommandState } from 'cloud-agent-sdk/remote-command-catalog';
import { useCallback, useMemo, useRef, useState } from 'react';
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
import {
  createMobileSlashCommandList,
  getSlashCommandCandidate,
  getSlashCommandSuggestions,
  parseChatComposerSubmission,
} from '@/components/agents/chat-composer-slash-commands';
import { executeChatComposerSubmission } from '@/components/agents/chat-composer-submission';
import { showRemoteCliExitConfirmation } from '@/components/agents/remote-cli-exit-alert';
import { SlashCommandSuggestions } from '@/components/agents/slash-command-suggestions';
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
import { createSubmitLock, type SubmitLock } from '@/lib/submit-lock';
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
  onSendCommand: (command: string, argumentsText: string) => Promise<boolean>;
  onCreateSession: () => Promise<boolean>;
  onExitCli: (onAccepted: () => void) => Promise<void>;
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
  /** Active resolved session type — drives slash command selection. */
  activeSessionType?: 'cloud-agent' | 'remote' | 'read-only' | null;
  /** Wrapper commands; remote presentation adds /new and capability-gated /exit after stripping aliases. */
  commands?: SlashCommandInfo[];
  /** Remote command state — empty for non-remote sessions. */
  commandState?: RemoteCommandState | null;
};

export function ChatComposer({
  onSend,
  onSendCommand,
  onCreateSession,
  onExitCli,
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
  activeSessionType = null,
  commands = [],
  commandState = null,
}: Readonly<ChatComposerProps>) {
  const colors = useThemeColors();
  const { showActionSheetWithOptions } = useActionSheet();
  const textRef = useRef('');
  const inputRef = useRef<TextInput>(null);
  const [hasText, setHasText] = useState(false);
  const [slashCommandInput, setSlashCommandInput] = useState<string | null>(null);
  const [inputWidth, setInputWidth] = useState(0);
  const [isFocused, setIsFocused] = useState(false);
  const [isSending, setIsSending] = useState(false);

  // Single send-admission authority. `settleVoiceInputBeforeSubmit` owns
  // this lock for the full voice-settle + asynchronous send sequence, and
  // `handleSelectSlashCommand` consults it synchronously so a suggestion tap
  // cannot mutate the draft while a send is in flight. A second submit can
  // never slip through the brief window where React has not yet committed
  // `isSending=true`.
  const sendLockRef = useRef<SubmitLock>(createSubmitLock());
  // `settleVoiceInputBeforeSubmit` expects a `{ current: boolean }` ref-like
  // and writes through it during settle. The adapter routes every read and
  // write through the SubmitLock above, so the helper participates in the
  // same admission gate without introducing a second, racing authority.
  const submissionLockRef: { current: boolean } = {
    get current() {
      return sendLockRef.current.isLocked();
    },
    set current(next: boolean) {
      if (next) {
        sendLockRef.current.acquire();
      } else {
        sendLockRef.current.release();
      }
    },
  };
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

  const commandList = useMemo(
    () => createMobileSlashCommandList(activeSessionType, commands, commandState),
    [activeSessionType, commandState, commands]
  );
  const slashCommandSuggestions =
    slashCommandInput === null ? [] : getSlashCommandSuggestions(slashCommandInput, commandList);

  function handleChangeText(value: string) {
    textRef.current = value;
    measure.setText(value);
    setHasText(value.trim().length > 0);
    setSlashCommandInput(getSlashCommandCandidate(value));
  }

  function clearDraft() {
    textRef.current = '';
    setHasText(false);
    setSlashCommandInput(null);
    measure.reset();
    inputRef.current?.clear();
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

    const submission = parseChatComposerSubmission(trimmed, commandList, {
      hasAttachments: upload.attachments.length > 0,
      sessionType: activeSessionType,
      remoteCommandState: commandState,
    });

    if (submission.type === 'attachment-error') {
      toast.error('Attachments cannot be sent with slash commands.');
      return;
    }
    if (submission.type === 'argument-error') {
      toast.error(submission.message);
      return;
    }
    if (submission.type === 'upgrade-required') {
      toast.error(submission.message);
      return;
    }

    // The admission lock is owned by `settleVoiceInputBeforeSubmit` for the
    // full settle + submit sequence, so `handleSend` performs validation and
    // executes the submission without re-acquiring/releasing the lock or
    // toggling pending state. That keeps one authority and lets the lock
    // protect the entire asynchronous send.
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    try {
      await executeChatComposerSubmission(
        submission,
        {
          onSendCommand,
          onCreateSession,
          onExitCli,
          confirmExitCli: showRemoteCliExitConfirmation,
          onSendPrompt: async prompt => {
            await onSend(prompt, upload.toWirePayload());
          },
        },
        {
          clearDraft,
          resetAttachments: () => {
            upload.reset();
          },
          dismiss: () => {
            Keyboard.dismiss();
          },
        }
      );
    } catch {
      // Draft preserved; error already surfaced by the caller. The helper
      // will release the lock and clear pending state in its finally block.
    }
  }

  function handleSelectSlashCommand(command: SlashCommandInfo) {
    // Same-render race guard: a suggestion row rendered before the send started
    // can be tapped while the lock is held. Because the lock is the authority
    // for admission to any composer mutation, bail synchronously instead of
    // relying on a later render to hide the list.
    if (sendLockRef.current.isLocked()) {
      return;
    }
    const value = `/${command.name} `;
    textRef.current = value;
    measure.setText(value);
    setHasText(true);
    setSlashCommandInput(null);
    inputRef.current?.setNativeProps({
      text: value,
      selection: { start: value.length, end: value.length },
    });
    inputRef.current?.focus();
  }

  async function submit() {
    // `settleVoiceInputBeforeSubmit` is the sole admission owner for the
    // entire voice-settle + asynchronous send sequence. It acquires the
    // SubmitLock, sets pending state, waits for the final transcript, runs
    // `handleSend`, and releases the lock in its finally block. Because the
    // lock is held throughout, `handleSend` does not acquire or release it.
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

      {slashCommandSuggestions.length > 0 && !isSending ? (
        <Animated.View entering={FadeIn.duration(150)} exiting={FadeOut.duration(100)}>
          <SlashCommandSuggestions
            commands={slashCommandSuggestions}
            onSelect={handleSelectSlashCommand}
          />
        </Animated.View>
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
