import { ArrowUp, Paperclip, Square } from 'lucide-react-native';
import { type RefObject } from 'react';
import {
  ActivityIndicator,
  type LayoutChangeEvent,
  Pressable,
  TextInput,
  type TextStyle,
  View,
} from 'react-native';

import { VoiceInputButton } from '@/components/voice-input-control';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type VoiceInputStatus } from '@/lib/voice-input/voice-input-state';

const PAPERCLIP_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
const CONTROL_HIT_SLOP = 6;

type ChatComposerInputRowProps = {
  attachmentsEnabled: boolean;
  canSend: boolean;
  disabled: boolean;
  inputAccessibilityDisabled: boolean;
  inputEditable: boolean;
  inputRef: RefObject<TextInput | null>;
  isSending: boolean;
  isStreaming: boolean;
  maxInputHeight: number;
  measureHeight: number;
  onAddAttachment: () => void;
  onChangeText: (text: string) => void;
  onInputBlur: () => void;
  onInputFocus: () => void;
  onInputLayout: (event: LayoutChangeEvent) => void;
  onStop: () => void;
  onSubmit: () => void;
  onToggleVoice: () => void;
  paperclipDisabled: boolean;
  placeholder: string;
  textInputStyle: TextStyle;
  voiceDisabled: boolean;
  voiceInputAvailable: boolean;
  voiceInputStatus: VoiceInputStatus;
};

/**
 * Bottom row of the Cloud Agent `ChatComposer`: paperclip, text input, voice
 * toggle, and the streaming / send control. Pure presentation — all gating
 * rules come from `resolveChatComposerControlState` in
 * `chat-composer-input-state.ts` and the parent owns the refs, state, and
 * submit/voice orchestration.
 */
export function ChatComposerInputRow({
  attachmentsEnabled,
  canSend,
  disabled,
  inputAccessibilityDisabled,
  inputEditable,
  inputRef,
  isSending,
  isStreaming,
  maxInputHeight,
  measureHeight,
  onAddAttachment,
  onChangeText,
  onInputBlur,
  onInputFocus,
  onInputLayout,
  onStop,
  onSubmit,
  onToggleVoice,
  paperclipDisabled,
  placeholder,
  textInputStyle,
  voiceDisabled,
  voiceInputAvailable,
  voiceInputStatus,
}: Readonly<ChatComposerInputRowProps>) {
  const colors = useThemeColors();

  return (
    <View className="flex-row items-center p-2.5 px-3">
      {attachmentsEnabled ? (
        <Pressable
          onPress={onAddAttachment}
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
          !inputEditable && 'opacity-50'
        )}
        onLayout={onInputLayout}
      >
        <TextInput
          ref={inputRef}
          placeholder={placeholder}
          placeholderTextColor={colors.mutedForeground}
          multiline
          maxLength={4000}
          onChangeText={onChangeText}
          onFocus={onInputFocus}
          onBlur={onInputBlur}
          style={textInputStyle}
          scrollEnabled={measureHeight >= maxInputHeight}
          editable={inputEditable}
          accessibilityState={{ disabled: inputAccessibilityDisabled }}
          returnKeyType="default"
          submitBehavior="newline"
          autoCapitalize="sentences"
          autoCorrect
        />
      </View>

      {!isStreaming && voiceInputAvailable ? (
        <View className="ml-1">
          <VoiceInputButton
            disabled={voiceDisabled}
            status={voiceInputStatus}
            onPress={onToggleVoice}
          />
        </View>
      ) : null}

      {isStreaming ? (
        <Pressable
          onPress={onStop}
          disabled={disabled}
          hitSlop={CONTROL_HIT_SLOP}
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
          onPress={onSubmit}
          disabled={!canSend}
          hitSlop={CONTROL_HIT_SLOP}
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
  );
}
