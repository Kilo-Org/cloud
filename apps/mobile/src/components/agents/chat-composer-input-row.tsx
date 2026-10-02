import { ArrowUp, CornerDownLeft, Paperclip, Square } from '@/components/ui/icons';
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';
import { type RefObject } from 'react';
import Animated, { FadeIn, FadeOut } from 'react-native-reanimated';
import { useTranslation } from 'react-i18next';
import {
  type LayoutChangeEvent,
  Platform,
  Pressable,
  TextInput,
  type TextInputSelectionChangeEvent,
  type TextStyle,
  View,
} from 'react-native';

import { shouldEnableComposerInputScroll } from '@/components/agents/chat-composer-input-height';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { ActivityIndicator } from '@/components/ui/activity-indicator';
import { Text } from '@/components/ui/text';
import { VoiceInputButton } from '@/components/voice-input-control';
import { useMotionPolicy } from '@/lib/a11y/motion';
import { COMPOSER_CONTROL_HIT_SLOP_DP } from '@/lib/a11y/tap-target';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { cn } from '@/lib/utils';
import { type VoiceInputStatus } from '@/lib/voice-input/voice-input-state';

const PAPERCLIP_HIT_SLOP = { top: 8, bottom: 8, left: 8, right: 8 } as const;
/** Minimum pressable size: 44pt on iOS, 48dp on Android (WCAG 2.5.8 AA). */
const CONTROL_HIT_TARGET = Platform.OS === 'android' ? 48 : 44;
/**
 * Cap on the OS font scale applied to the cannot-send reason. The reason wraps
 * above the controls, so a larger accessibility scale grows it vertically
 * instead of truncating the actionable tail; capping the scale bounds how far
 * it can grow. 1.6 keeps the longest translated reason whole on a phone.
 */
export const COMPOSER_REASON_MAX_FONT_SCALE = 1.6;
/**
 * Leading gap between the controls of this row, as a class: `ms-3` is the
 * `COMPOSER_CONTROL_GAP_DP` of `@/lib/a11y/tap-target` (0.75rem at
 * NativeWind's 14pt rem). It is a START-side margin, not a physical `ml-`,
 * so it stays on the side a control faces its neighbour on when the row
 * mirrors under RTL (`marginInlineStart` resolves to Yoga Start in both
 * directions; `screen-header.tsx` documents the same choice). That gap is
 * wider than the two facing hit slops (the voice toggle's
 * `VOICE_INPUT_LG_HIT_SLOP_DP` plus `COMPOSER_CONTROL_HIT_SLOP_DP`), so
 * neighbouring controls keep separate tap areas. Without it a control renders
 * flush against the one before it: the microphone and the send/stop circles
 * merged into a single shape and their tap areas overlapped (spot check e1 /
 * e1-en-two-msg). Every control but the leading paperclip carries this same
 * class — the paperclip only ever meets the input, whose own start margin is
 * the gap after it — so the input and each trailing control sit one gap apart
 * and a trailing control added without it cannot sit flush against its
 * neighbour again.
 */
export const COMPOSER_CONTROL_GAP_CLASS = 'ms-3';

type ChatComposerInputRowProps = {
  attachmentsEnabled: boolean;
  canSend: boolean;
  disabled: boolean;
  hasSendableContent: boolean;
  inputAccessibilityDisabled: boolean;
  inputEditable: boolean;
  /**
   * Whether the live input holds no text. Drives the single-line placeholder
   * overlay: the native hint has no line cap, so a placeholder wider than the
   * field wraps onto a second line that the field's height clips against its
   * border (French "Configuration de l'environnement…" on a narrow phone).
   */
  inputEmpty: boolean;
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
  /**
   * Report the input's own rendered content height in dp. The composer uses it
   * as the one faithful measure of the pitch this input lays lines out at (see
   * `useTextHeight`).
   */
  onInputContentSizeChange: (contentHeight: number) => void;
  onInsertNewline: () => void;
  onSelectionChange: (event: TextInputSelectionChangeEvent) => void;
  onStop: () => void;
  onSubmit: () => void;
  onToggleVoice: () => void;
  paperclipDisabled: boolean;
  placeholder: string;
  /** Return submits the message instead of inserting a newline. */
  returnSendsMessage: boolean;
  /**
   * Why send is unavailable, rendered as a reason above the controls and
   * announced when it changes. It wraps rather than truncates: a long
   * translation must keep its actionable tail ("Retry first.") on a phone.
   * Null while send can proceed or when the parent knows no reason.
   */
  sendDisabledReason?: string | null;
  /**
   * Tone for `sendDisabledReason`: `error` (the default) paints it in the
   * destructive color; `neutral` keeps a progress phase ("Setting up
   * environment…") or the generic not-ready line in the status tone so it does
   * not read as a failure.
   */
  sendDisabledReasonTone?: 'error' | 'neutral' | null;
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
  hasSendableContent,
  inputAccessibilityDisabled,
  inputEditable,
  inputEmpty,
  inputRef,
  isSending,
  isStreaming,
  maxInputHeight,
  measureHeight,
  onAddAttachment,
  onChangeText,
  onInputBlur,
  onInputFocus,
  onInputContentSizeChange,
  onInputLayout,
  onInsertNewline,
  onSelectionChange,
  onStop,
  onSubmit,
  onToggleVoice,
  paperclipDisabled,
  placeholder,
  returnSendsMessage,
  sendDisabledReason,
  sendDisabledReasonTone,
  textInputStyle,
  voiceDisabled,
  voiceInputAvailable,
  voiceInputStatus,
}: Readonly<ChatComposerInputRowProps>) {
  const colors = useThemeColors();
  const { t } = useTranslation();
  const { reducedMotion } = useMotionPolicy();
  const inputScrollable = shouldEnableComposerInputScroll(measureHeight, maxInputHeight);

  // The overlay shares the input's text rect exactly — same font size, line
  // height and insets, and no Android font padding — so the first typed
  // character lands where the hint sat. `position` rides on `className`; the
  // metrics stay in a named style object because NativeWind has no utility for
  // `includeFontPadding`.
  const placeholderStyle: TextStyle = {
    top: textInputStyle.paddingVertical,
    left: textInputStyle.paddingHorizontal,
    right: textInputStyle.paddingHorizontal,
    color: colors.mutedForeground,
    fontSize: textInputStyle.fontSize,
    includeFontPadding: false,
    lineHeight: textInputStyle.lineHeight,
  };

  return (
    // The root is a column, not the old non-wrapping `flex-row`: the reason is
    // a block of its own above the controls, so it can never squeeze the
    // flex-1 input or push the trailing send control off the screen.
    <View className="p-2.5 px-3">
      {sendDisabledReason ? (
        <AccessibleStatus
          message={sendDisabledReason}
          tone={sendDisabledReasonTone === 'neutral' ? 'status' : 'error'}
          maxFontSizeMultiplier={COMPOSER_REASON_MAX_FONT_SCALE}
          className="mb-1 text-right text-xs"
        />
      ) : null}

      <View className="flex-row items-center">
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
            accessibilityLabel={t('agentChat.composer.addAttachment')}
            accessibilityState={{ disabled: paperclipDisabled }}
          >
            <Paperclip size={18} color={colors.mutedForeground} />
          </Pressable>
        ) : null}

        <View
          className={cn(
            COMPOSER_CONTROL_GAP_CLASS,
            'flex-1 overflow-hidden rounded-[20px] border border-border bg-card',
            !inputEditable && 'opacity-50'
          )}
          onLayout={onInputLayout}
        >
          {/* The placeholder is a single-line overlay, not the input's own hint:
            Android lays the native hint out at the field's width with no line
            cap, so copy wider than the field wraps onto a second line that the
            field's fixed height clips against its border. A tail-ellipsized
            Text truncates the copy at any width instead. It shares the input's
            font metrics (same size, line height, padding and top-aligned text
            rect) so the first typed character lands exactly where it sat, and
            sits under the input so a keystroke paints over it. */}
          {inputEmpty && placeholder.length > 0 ? (
            <Text
              accessible={false}
              numberOfLines={1}
              ellipsizeMode="tail"
              allowFontScaling={false}
              pointerEvents="none"
              // The design-system Text is `font-medium`; the input's own text is
              // the platform default weight, so the hint drops to `font-normal`
              // to keep the metrics it shares with the text it stands in for.
              className="absolute font-normal"
              style={placeholderStyle}
            >
              {placeholder}
            </Text>
          ) : null}
          <TextInput
            ref={inputRef}
            // The hint is drawn by the overlay above, but Android still needs an
            // accessible name for the field, and the hint used to be it.
            accessibilityLabel={placeholder}
            multiline
            maxLength={CLOUD_AGENT_PROMPT_MAX_LENGTH}
            onChangeText={onChangeText}
            onContentSizeChange={event => {
              onInputContentSizeChange(event.nativeEvent.contentSize.height);
            }}
            onFocus={onInputFocus}
            onBlur={onInputBlur}
            onSelectionChange={onSelectionChange}
            style={textInputStyle}
            scrollEnabled={inputScrollable}
            editable={inputEditable}
            contextMenuHidden={!inputEditable}
            pointerEvents={inputEditable ? 'auto' : 'none'}
            accessibilityState={{ disabled: inputAccessibilityDisabled }}
            returnKeyType={returnSendsMessage ? 'send' : 'default'}
            submitBehavior={returnSendsMessage ? 'submit' : 'newline'}
            onSubmitEditing={returnSendsMessage ? onSubmit : undefined}
            maxFontSizeMultiplier={1}
            autoCapitalize="sentences"
            autoCorrect
          />
        </View>

        {returnSendsMessage ? (
          <View className={COMPOSER_CONTROL_GAP_CLASS}>
            <Pressable
              onPress={onInsertNewline}
              disabled={!inputEditable}
              hitSlop={COMPOSER_CONTROL_HIT_SLOP_DP}
              accessibilityRole="button"
              accessibilityLabel={t('agentChat.composer.insertNewline')}
              accessibilityState={{ disabled: !inputEditable }}
              style={{ minHeight: CONTROL_HIT_TARGET, minWidth: CONTROL_HIT_TARGET }}
              className={cn(
                'items-center justify-center rounded-full active:opacity-70',
                !inputEditable && 'opacity-50'
              )}
            >
              <CornerDownLeft size={18} color={colors.mutedForeground} />
            </Pressable>
          </View>
        ) : null}

        {voiceInputAvailable ? (
          <View className={COMPOSER_CONTROL_GAP_CLASS}>
            <VoiceInputButton
              disabled={voiceDisabled}
              size="lg"
              status={voiceInputStatus}
              onPress={onToggleVoice}
            />
          </View>
        ) : null}

        <View className={COMPOSER_CONTROL_GAP_CLASS}>
          {isStreaming && !hasSendableContent && !isSending ? (
            <Animated.View
              key="stop"
              entering={reducedMotion ? undefined : FadeIn.duration(150)}
              exiting={reducedMotion ? undefined : FadeOut.duration(100)}
            >
              <Pressable
                onPress={onStop}
                disabled={disabled}
                hitSlop={COMPOSER_CONTROL_HIT_SLOP_DP}
                accessibilityRole="button"
                accessibilityLabel={t('agentChat.composer.stopGenerating')}
                accessibilityState={{ disabled }}
                style={{ height: CONTROL_HIT_TARGET, width: CONTROL_HIT_TARGET }}
                className={cn(
                  'items-center justify-center rounded-full bg-neutral-400 active:opacity-70 dark:bg-neutral-500',
                  disabled && 'opacity-50'
                )}
              >
                <Square size={14} color="white" fill="white" />
              </Pressable>
            </Animated.View>
          ) : (
            <Animated.View
              key="send"
              entering={reducedMotion ? undefined : FadeIn.duration(150)}
              exiting={reducedMotion ? undefined : FadeOut.duration(100)}
            >
              <Pressable
                onPress={onSubmit}
                disabled={!canSend}
                hitSlop={COMPOSER_CONTROL_HIT_SLOP_DP}
                accessibilityRole="button"
                accessibilityLabel={t('common.sendMessage')}
                accessibilityHint={sendDisabledReason ?? undefined}
                accessibilityState={{ disabled: !canSend, busy: isSending }}
                style={{ height: CONTROL_HIT_TARGET, width: CONTROL_HIT_TARGET }}
                className={`items-center justify-center rounded-full active:opacity-70 ${
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
            </Animated.View>
          )}
        </View>
      </View>
    </View>
  );
}
