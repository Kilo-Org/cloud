import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Pressable, TextInput, View } from 'react-native';

import { Text } from '@/components/ui/text';
import { AccessibleStatus } from '@/components/ui/accessible-status';
import { VoiceInputButton, VoiceInputStatus } from '@/components/voice-input-control';
import { useThemeColors } from '@/lib/hooks/use-theme-colors';
import { applyVoiceDraftToInput } from '@/lib/voice-input/voice-input-draft';
import { resolveVoiceInputFeedbackPresentation } from '@/lib/voice-input/voice-input-feedback';
import { useVoiceInput } from '@/lib/voice-input/use-voice-input';

/**
 * Requirement 3 surface: a free-text area in voice settings that shows the
 * live effect of the current configuration. Interim and final transcripts —
 * gateway streaming segments and OS interim results alike — arrive through
 * `onDraftChange`, so the user can confirm the chosen language and model
 * without leaving the screen.
 *
 * The input stays uncontrolled on iOS (AGENTS.md): text lives in `textRef`,
 * `hasText` only drives the Clear affordance, and every speech write goes
 * through `applyVoiceDraftToInput`. Feedback for a failed or refused start
 * stays in the shared voice stack: transient failures are mirrored inline
 * below the field (sonner-native toasts sit outside the accessibility tree),
 * while alert-backed failures render on their own alert surface.
 */
export function VoiceTestField(): React.ReactElement {
  const { t } = useTranslation();
  const colors = useThemeColors();
  const inputRef = useRef<TextInput>(null);
  const textRef = useRef('');
  const [hasText, setHasText] = useState(false);

  const handleTextChange = (text: string) => {
    textRef.current = text;
    setHasText(text.length > 0);
  };

  const voice = useVoiceInput({
    disabled: false,
    getDraft: () => textRef.current,
    onDraftChange: draft => {
      applyVoiceDraftToInput({ draft, input: inputRef.current, onChangeText: handleTextChange });
    },
  });

  const handleClear = () => {
    if (voice.isActive) {
      void voice.abort();
    }
    // `clear()` drives the native `setTextAndSelection` command with the
    // most-recent event count. `setNativeProps({ text: '' })` leaves the
    // native text in place on Android/Fabric, so the field kept its text
    // after the tap (e14, 2026-09-12).
    inputRef.current?.clear();
    handleTextChange('');
  };

  // Rendered disabled rather than hidden: the control row keeps its height
  // while there is nothing to clear, so starting a session never shifts it.
  const clearDisabled = !hasText && !voice.isActive;

  // Transient failures (a dropped gateway, no speech) keep the message next to
  // the microphone as well as in the toast. sonner-native draws the toast
  // outside the accessibility hierarchy, so this inline `AccessibleStatus` is
  // the only copy a screen reader — or the on-device hierarchy digest the e2
  // scenario reads — can see. Alert-backed feedback already has its own
  // surface, so it is not mirrored here.
  const inlineFailure =
    voice.feedback && resolveVoiceInputFeedbackPresentation(voice.feedback).kind === 'toast'
      ? voice.feedback
      : null;

  return (
    <View className="gap-2 rounded-lg bg-secondary px-3 py-3">
      <Text className="text-sm font-medium text-foreground">{t('voiceInput.testTitle')}</Text>
      <TextInput
        ref={inputRef}
        className="min-h-24 rounded-md border border-input bg-background px-3 py-2 text-base leading-6 text-foreground"
        defaultValue=""
        multiline
        onChangeText={handleTextChange}
        placeholder={t('voiceInput.testPlaceholder')}
        placeholderTextColor={colors.mutedForeground}
        textAlignVertical="top"
      />
      <View className="flex-row items-center gap-3">
        <VoiceInputButton
          disabled={!voice.available}
          onPress={() => void voice.toggle()}
          size="md"
          status={voice.status}
        />
        <VoiceInputStatus status={voice.status} />
        {inlineFailure ? (
          <AccessibleStatus
            className="flex-1 text-xs"
            message={inlineFailure.message}
            tone="error"
          />
        ) : null}
        <Pressable
          accessibilityLabel={t('voiceInput.testClear')}
          accessibilityRole="button"
          // 44pt effective target (DESIGN.md): the compact text label sits in a
          // min-h-[44px]/min-w-[44px] centered box. Arbitrary px is required —
          // rem-scaled min-h-11/min-w-11 renders ~38.5pt tall on device because
          // NativeWind's rem is ~14px here (e14, 2026-09-12).
          // disabled:opacity-50 separates the inert state from the live one.
          className="ml-auto min-h-[44px] min-w-[44px] items-center justify-center px-2 active:opacity-70 disabled:opacity-50"
          disabled={clearDisabled}
          onPress={handleClear}
        >
          <Text className="text-sm text-muted-foreground">{t('voiceInput.testClear')}</Text>
        </Pressable>
      </View>
    </View>
  );
}
