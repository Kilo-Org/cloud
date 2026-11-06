/* eslint-disable max-lines -- The new-session prompt owns its uncontrolled input, starter chips, counter, newline control, voice dictation, and attachment strip end-to-end in one cohesive surface. */
import { CLOUD_AGENT_PROMPT_MAX_LENGTH } from '@kilocode/cloud-agent-sdk/limits';
import { LinearGradient } from 'expo-linear-gradient';
import { useCallback, useEffect, useRef, useState } from 'react';
import Animated, {
  createAnimatedComponent,
  useAnimatedStyle,
  useSharedValue,
} from 'react-native-reanimated';
import { useKeyboardMotionProgress } from '@/components/keyboard-motion-provider';
import {
  AccessibilityInfo,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
  Platform,
  Pressable,
  TextInput as RNTextInput,
  type TextInput,
  type TextInputSelectionChangeEvent,
  type TextStyle,
  View,
} from 'react-native';
import { useLiveFontScale } from '@/lib/font-scale/system-font-scale-context';
import { TOUCH_TARGET_DP } from '@/lib/a11y/tap-target';
import { CornerDownLeft } from '@/components/ui/icons';
import { toast } from 'sonner-native';
import { useTranslation } from 'react-i18next';

import { AttachmentPreviewStrip } from '@/components/agents/attachment-preview-strip';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { Text } from '@/components/ui/text';
import {
  type ComposerSelection,
  pasteTextIntoComposer,
} from '@/components/agents/composer-paste-text';
import { ChatToolbar } from '@/components/agents/chat-toolbar';
import {
  NEW_SESSION_PROMPT_DEFAULT_LINES,
  NEW_SESSION_PROMPT_LINE_HEIGHT,
  resolveNewSessionPromptHeight,
  shouldEnableComposerInputScroll,
} from '@/components/agents/chat-composer-input-height';
import { useReturnSendsMessagePreference } from '@/lib/hooks/use-return-sends-message-preference';
import {
  resolveNewSessionPromptControlState,
  resolvePromptCounterRemaining,
} from '@/components/agents/new-session-prompt-state';
import {
  resolveComposerTopFadeHeight,
  resolveNewSessionPromptMinHeight,
} from '@/components/agents/new-session-prompt-fit';
import { NewSessionPromptClone } from '@/components/agents/new-session-prompt-clone';
import { NewSessionPromptControls } from '@/components/agents/new-session-prompt-controls';
import { type NewSessionPromptProps } from '@/components/agents/new-session-prompt-types';
import { hasVisibleComposerText } from '@/lib/composer-text';
import { QueryError } from '@/components/query-error';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { useSharePrefill } from '@/lib/share-prefill';
import { SharePrefillFailure } from '@/components/agents/share-prefill-failure';
import { resolveAlphaColor } from '@/lib/theme-color';
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
  clipboardPasteFailureMessage,
  useClipboardPaste,
} from '@/lib/agent-attachments/use-clipboard-paste';

// Mirrors the input's `text-base`.
const PROMPT_INPUT_FONT_SIZE = 16;
const PROMPT_INPUT_ANDROID_HORIZONTAL_INSET = 24;
/**
 * The input's `py-2` in dp: NativeWind's native rem is 14, so the utility is
 * 7, which the design-gate dump reports as `paddingBlock: 7`. The top fade
 * starts here, at the text box, so the 1 dp band where a scrolled line is
 * clipped is covered rather than left as a hard cut.
 */
const PROMPT_INPUT_VERTICAL_INSET = 7;
/** A sub-pixel scroll is not a hidden line above the field. */
const PROMPT_SCROLLED_THRESHOLD = 0.5;
const PROMPT_INPUT_MAX_CHARS = CLOUD_AGENT_PROMPT_MAX_LENGTH;
/** Minimum pressable size: 44pt on iOS, 48dp on Android (WCAG 2.5.8 AA). */
const PROMPT_HIT_TARGET = Platform.OS === 'android' ? 48 : 44;
// LinearGradient is not NativeWind-mapped; the physical style objects follow
// the skeleton.tsx overlay pattern. The band starts at the text box, where a
// scrolled field clips its topmost line, and its height comes from the scroll
// offset on the UI thread.
const PROMPT_TOP_FADE_STYLE = {
  position: 'absolute',
  left: 0,
  right: 0,
  top: PROMPT_INPUT_VERTICAL_INSET,
} as const;
const PROMPT_TOP_FADE_FILL = { flex: 1 } as const;
const AnimatedPromptInput = createAnimatedComponent(RNTextInput);

type NewSessionPromptComponentProps = NewSessionPromptProps & {
  /**
   * Return (when the Return-sends preference is on) triggers the host's Start
   * flow. Omitted by hosts that have not wired the preference, so Return is a
   * no-op there rather than starting on its own.
   */
  onStartSession?: () => void;
};

/**
 * New-session prompt surface: model/mode toolbar, attachment strip,
 * full-width multiline text input, and bottom action row (paperclip leading,
 * voice toggle trailing). Owns the prompt ref (for voice input to read), the
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
  frameHeight,
  keyboardClosedFrameHeight,
  cardTop = 0,
  lineCount = NEW_SESSION_PROMPT_DEFAULT_LINES,
  keyboardClosedLineCount = lineCount,
  onStartSession,
  isCloneEntry = false,
  autoFocusOnMount = true,
}: Readonly<NewSessionPromptComponentProps>) {
  // The input never takes focus for a share payload, whatever the host decides:
  // the payload prefills the composer, and raising the keyboard on arrival hides
  // the attachment strip and Start. The veto stays here so a host that keeps the
  // prop's default cannot lose it.
  const takesFocusOnMount = autoFocusOnMount && (shareId === undefined || shareId === '');
  const colors = useThemeColors();
  const { t } = useTranslation();
  const fontScale = useLiveFontScale();
  const { returnSendsMessage } = useReturnSendsMessagePreference();
  // The counter's remaining count, or null while it is hidden. Only the value
  // the card renders is held: the raw character count is not, so a keystroke
  // that leaves the counter hidden publishes nothing and re-renders nothing.
  const [counterRemaining, setCounterRemaining] = useState<number | null>(() =>
    resolvePromptCounterRemaining(initialPrompt?.length ?? 0)
  );
  const publishedCounterRef = useRef<number | null>(
    resolvePromptCounterRemaining(initialPrompt?.length ?? 0)
  );
  const promptRef = useRef(initialPrompt ?? '');
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
  const promptLineHeight = NEW_SESSION_PROMPT_LINE_HEIGHT * fontScale;
  // The card rows that render only in some states, read by name in the render
  // below (the measured card chrome covers their height without a static
  // budget, so they need no separate reservation here).
  const showsAttachmentStatus = attachments.some(
    attachment => attachment.metadataStripFailed === true
  );
  const showsCounter = counterRemaining !== null;
  const [topChromeHeight, setTopChromeHeight] = useState(0);
  const [bottomChromeHeight, setBottomChromeHeight] = useState(0);
  const cardChromeHeight =
    topChromeHeight > 0 && bottomChromeHeight > 0 ? topChromeHeight + bottomChromeHeight + 2 : 0;
  const fit = {
    cardTop,
    cardChromeHeight,
    preferredMinHeight: resolveNewSessionPromptHeight(promptLineHeight, lineCount),
    lineHeight: promptLineHeight,
    preferredLines: lineCount,
  };
  const promptHeight = resolveNewSessionPromptMinHeight({ ...fit, frameHeight: frameHeight ?? 0 });
  const closedPromptHeight = resolveNewSessionPromptMinHeight({
    ...fit,
    preferredMinHeight: resolveNewSessionPromptHeight(promptLineHeight, keyboardClosedLineCount),
    preferredLines: keyboardClosedLineCount,
    frameHeight: keyboardClosedFrameHeight ?? frameHeight ?? 0,
  });
  const keyboardProgress = useKeyboardMotionProgress();
  const promptHeightStyle = useAnimatedStyle(() => ({
    height:
      closedPromptHeight +
      (promptHeight - closedPromptHeight) * Math.max(0, Math.min(1, keyboardProgress.value)),
  }));

  // The draft's own laid-out height, reported by the input on every content
  // change. The field keeps its size, so this only decides whether a vertical
  // drag over the field scrolls the draft or the form behind it: a drag over a
  // field whose text fits belongs to the form, exactly as it did when the field
  // grew to its text and only scrolled once the cap stopped it.
  const [contentHeight, setContentHeight] = useState(0);
  const promptScrolls = shouldEnableComposerInputScroll(contentHeight, promptHeight);
  // The fade band over the clipped top line, driven from the field's scroll
  // offset. It lives in a shared value, not React state: a drag reports a frame
  // per few pixels, and this card's toolbar, attachment strip and controls are
  // not memoized, so committing each offset would re-render all of them at
  // frame rate just to resize an overlay. Only the crossing that mounts the
  // gradient is state.
  const promptScrollOffset = useSharedValue(0);
  const [promptFaded, setPromptFaded] = useState(false);
  const promptTopFadeStyle = useAnimatedStyle(() => ({
    height: resolveComposerTopFadeHeight({
      scrollOffset: promptScrollOffset.value,
      lineHeight: promptLineHeight,
    }),
  }));

  function handlePromptScroll(event: NativeSyntheticEvent<NativeScrollEvent>) {
    const next = Math.max(0, event.nativeEvent.contentOffset.y);
    promptScrollOffset.value = next;
    const faded = next > PROMPT_SCROLLED_THRESHOLD;
    setPromptFaded(current => (current === faded ? current : faded));
  }

  const promptInputStyle = {
    color: colors.foreground,
    includeFontPadding: false,
    fontSize: PROMPT_INPUT_FONT_SIZE * fontScale,
    lineHeight: promptLineHeight,
    textAlignVertical: 'top',
  } satisfies TextStyle;
  // The one-line floor is shorter than the touch target. The slop makes the
  // field's whole height reachable without taking room from the sections under
  // the card, which the short window has none of.
  const promptHitSlopDp = Math.max(0, (TOUCH_TARGET_DP - promptHeight) / 2);

  // Publish the counter only when the value the card renders changes: the
  // count stays hidden until the draft nears the limit, and republishing the
  // raw length re-rendered this card — its toolbar, attachment strip, controls
  // and voice surface — on every keystroke of a draft that never shows it.
  const publishCounter = useCallback((length: number) => {
    const next = resolvePromptCounterRemaining(length);
    if (next === publishedCounterRef.current) {
      return;
    }
    publishedCounterRef.current = next;
    setCounterRemaining(next);
  }, []);

  const handlePromptChange = useCallback(
    (text: string) => {
      promptRef.current = text;
      publishCounter(text.length);
      onChangeText(text);
    },
    [onChangeText, publishCounter]
  );

  const sharePrefill = useSharePrefill({
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
      // The hook calls the latest render's callback, so this sees a create
      // that started during the clipboard read. A create already holds its own
      // snapshot, so a late paste must not land in the draft behind it.
      // `NewSessionPrompt` holds no submit lock, so the button's own disabled
      // rule is the authority.
      if (control.draftMutationLocked) {
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
      toast.error(clipboardPasteFailureMessage(reason) ?? describeClassificationFailure(reason));
    },
    maxBytes: AGENT_ATTACHMENT_MAX_BYTES,
  });

  function handlePromptSelectionChange(event: TextInputSelectionChangeEvent) {
    promptSelectionRef.current = event.nativeEvent.selection;
  }

  function handleInsertNewline() {
    if (control.draftMutationLocked) {
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
    if (control.createDisabled || !hasVisibleComposerText(promptRef.current)) {
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
      <View
        className="pb-2"
        onLayout={event => {
          setTopChromeHeight(event.nativeEvent.layout.height);
        }}
      >
        {isModelsError && modelOptions.length === 0 ? (
          <QueryError
            placement="top"
            variant="server"
            title={t('agentChat.newSession.couldNotLoadModels')}
            message={t('organization.boundary.loadErrorMessage')}
            onRetry={() => {
              onRefetchModels();
            }}
            className="border-b border-border py-4"
          />
        ) : (
          <ChatToolbar
            modeControl={{ mode, onModeChange, customOptions }}
            model={model}
            variant={variant}
            modelOptions={modelOptions}
            onModelSelect={onModelSelect}
            disabled={isCreating}
            isLoadingModels={isLoadingModels}
            modelLocked={modelLocked}
            modelLockLabel={modelLockLabel}
            className="border-b border-border bg-neutral-100 dark:bg-neutral-900 px-3 py-3"
          />
        )}
        {sharePrefill.failed ? (
          <SharePrefillFailure
            onRetry={() => {
              sharePrefill.retry();
            }}
            onDismiss={() => {
              sharePrefill.dismiss();
            }}
          />
        ) : null}
        <AttachmentPreviewStrip
          attachments={attachments}
          onRemove={onRemoveAttachment}
          onRetry={onRetryAttachment}
          onMove={onMoveAttachment}
          onReorder={onReorderAttachments}
        />
        {showsAttachmentStatus ? (
          <AccessibleStatus
            tone="error"
            message={t('agentChat.composer.photoMetadataNotRemoved')}
            className="mb-2 px-4 text-xs"
          />
        ) : null}
      </View>
      <View className="px-2">
        <View>
          <AnimatedPromptInput
            ref={promptInputRef}
            placeholder={t('agentChat.newSession.promptPlaceholder')}
            placeholderTextColor={colors.mutedForeground}
            multiline
            defaultValue={initialPrompt}
            // No dimming while a create is in flight: the field stays editable
            // (an in-flight create must not steal the IME from the pinned
            // footer), so it must not read as disabled. The busy affordance is
            // the Start button's own spinner. An edit made mid-flight is not
            // discarded: the creator cancels the attempt before it dispatches
            // and keeps this draft (see `createSessionFromDraft`).
            className="w-full px-2 py-2 text-base leading-[1.5rem] text-foreground"
            style={[
              promptInputStyle,
              promptHeightStyle,
              Platform.OS === 'android'
                ? { paddingHorizontal: PROMPT_INPUT_ANDROID_HORIZONTAL_INSET }
                : undefined,
            ]}
            onChangeText={handlePromptChange}
            onSelectionChange={handlePromptSelectionChange}
            hitSlop={
              promptHitSlopDp > 0
                ? { top: promptHitSlopDp, right: 0, bottom: promptHitSlopDp, left: 0 }
                : undefined
            }
            onContentSizeChange={event => {
              const next = Math.round(event.nativeEvent.contentSize.height * 100) / 100;
              setContentHeight(current => (current === next ? current : next));
              if (!shouldEnableComposerInputScroll(next, promptHeight)) {
                // The draft fits again: the field is back at its top, where the
                // first line is whole.
                promptScrollOffset.value = 0;
                setPromptFaded(false);
              }
            }}
            onScroll={handlePromptScroll}
            scrollEnabled={promptScrolls}
            maxLength={PROMPT_INPUT_MAX_CHARS}
            returnKeyType={returnSendsMessage ? 'send' : 'default'}
            submitBehavior={returnSendsMessage ? 'submit' : 'newline'}
            onSubmitEditing={returnSendsMessage ? handleReturnSubmit : undefined}
            maxFontSizeMultiplier={1}
            // Focus on arrival only when the form has nothing left to configure
            // (the host resolves this) and no share payload prefills it: the
            // keyboard it raises would otherwise shrink the frame past the
            // repository, Environment and Advanced sections the session still
            // needs before it can start.
            autoFocus={takesFocusOnMount}
            // Android's IME swaps the app for its full-screen extract editor in a
            // landscape window; IME_FLAG_NO_FULLSCREEN keeps the field in place.
            disableFullscreenUI
          />
          {promptFaded ? (
            <Animated.View
              className="absolute left-0 right-0"
              pointerEvents="none"
              style={[PROMPT_TOP_FADE_STYLE, promptTopFadeStyle]}
            >
              <LinearGradient
                // The card's own color, so the slice fades into the surface
                // behind it instead of drawing a bar of its own.
                colors={[resolveAlphaColor(colors.card, 1), resolveAlphaColor(colors.card, 0)]}
                start={{ x: 0.5, y: 0 }}
                end={{ x: 0.5, y: 1 }}
                style={PROMPT_TOP_FADE_FILL}
              />
            </Animated.View>
          ) : null}
        </View>
        <View
          onLayout={event => {
            setBottomChromeHeight(event.nativeEvent.layout.height);
          }}
        >
          {showsCounter ? (
            <View className="flex-row justify-end px-1 pb-1">
              {/* i18n-dup-ok: 'agentChat.composer.charactersRemaining_other' is this counted message's plural other category — the bare key carries that copy by i18next convention, and every catalog inflects the family by its own count rules. */}
              <Text
                className="text-xs font-normal text-muted-foreground"
                accessibilityLabel={t('agentChat.composer.charactersRemaining', {
                  count: counterRemaining,
                })}
              >
                {counterRemaining}
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
                  disabled={control.draftMutationLocked}
                  hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
                  accessibilityRole="button"
                  accessibilityLabel={t('agentChat.composer.insertNewline')}
                  accessibilityState={{ disabled: control.draftMutationLocked }}
                  style={{ minHeight: PROMPT_HIT_TARGET, minWidth: PROMPT_HIT_TARGET }}
                  className={cn(
                    'items-center justify-center rounded-full active:opacity-70',
                    control.draftMutationLocked && 'opacity-50'
                  )}
                >
                  <CornerDownLeft size={18} color={colors.mutedForeground} />
                </Pressable>
              </View>
            ) : null}
          </NewSessionPromptControls>
        </View>
      </View>
    </View>
  );
}
